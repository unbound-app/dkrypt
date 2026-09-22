#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#import <CommonCrypto/CommonHMAC.h>
#import <arpa/inet.h>
#import <errno.h>
#import <fcntl.h>
#import <math.h>
#import <netinet/in.h>
#import <poll.h>
#import <signal.h>
#import <spawn.h>
#import <dispatch/dispatch.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/time.h>
#import <sys/wait.h>
#import <unistd.h>

extern char **environ;

static NSString * const kSecretPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-bridge.secret";
static NSString * const kAgentVersion = AGENT_VERSION;
static const uint16_t kPort = 5913;
static const uint32_t kMaxFrameBytes = 4u * 1024u * 1024u;
static const NSUInteger kMaxReplayEntries = 256;
static const int kClientReceiveTimeoutSeconds = 600;
static const int kClientSendTimeoutSeconds = 600;

static BOOL readFully(int fd, void *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = read(fd, (uint8_t *)buffer + offset, length - offset);
        if (count > 0) {
            offset += (size_t)count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        return NO;
    }
    return YES;
}

static BOOL writeFully(int fd, const void *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = write(fd, (const uint8_t *)buffer + offset, length - offset);
        if (count > 0) {
            offset += (size_t)count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        return NO;
    }
    return YES;
}

static NSString *base64URLEncode(NSData *data) {
    NSString *encoded = [data base64EncodedStringWithOptions:0];
    encoded = [encoded stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
    encoded = [encoded stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
    return [encoded stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

static NSData *base64URLDecode(NSString *value) {
    NSString *encoded = [[value stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
    while (encoded.length % 4 != 0) encoded = [encoded stringByAppendingString:@"="];
    return [[NSData alloc] initWithBase64EncodedString:encoded options:0];
}

static NSString *hmacHex(NSString *secret, NSString *message) {
    NSData *keyData = [secret dataUsingEncoding:NSUTF8StringEncoding];
    NSData *messageData = [message dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, keyData.bytes, keyData.length, messageData.bytes, messageData.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    return hex;
}

static BOOL constantTimeEqual(NSString *left, NSString *right) {
    NSData *leftData = [left dataUsingEncoding:NSUTF8StringEncoding];
    NSData *rightData = [right dataUsingEncoding:NSUTF8StringEncoding];
    if (leftData.length != rightData.length) return NO;
    const uint8_t *leftBytes = leftData.bytes;
    const uint8_t *rightBytes = rightData.bytes;
    uint8_t difference = 0;
    for (NSUInteger index = 0; index < leftData.length; index++) difference |= leftBytes[index] ^ rightBytes[index];
    return difference == 0;
}

static NSString *readSecret(void) {
    NSString *secret = [NSString stringWithContentsOfFile:kSecretPath encoding:NSUTF8StringEncoding error:nil];
    return [secret stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static NSData *jsonData(id value) {
    return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
}

static NSDictionary *signedResponse(NSString *secret, NSString *requestId, BOOL ok, NSDictionary *result, NSDictionary *error) {
    NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{ @"ok": @(ok) }];
    if (result) payload[@"result"] = result;
    if (error) payload[@"error"] = error;
    NSData *payloadData = jsonData(payload);
    NSString *encodedPayload = base64URLEncode(payloadData ?: [NSData data]);
    NSNumber *issuedAt = @((long long)[[NSDate date] timeIntervalSince1970]);
    NSString *message = [NSString stringWithFormat:@"dkrypt-autoinstall-agent-response-v1|%@|%@|%@", requestId, issuedAt, encodedPayload];
    return @{
        @"version": @1,
        @"requestId": requestId ?: @"",
        @"issuedAt": issuedAt,
        @"payload": encodedPayload,
        @"signature": hmacHex(secret, message),
    };
}

static NSDictionary *bootstrapResponse(NSString *requestId, BOOL ok, NSString *errorCode) {
    NSMutableDictionary *response = [@{
        @"version": @1,
        @"requestId": requestId ?: @"",
        @"ok": @(ok),
    } mutableCopy];
    if (errorCode.length > 0) response[@"error"] = errorCode;
    return response;
}

static BOOL sendFrame(int fd, NSDictionary *frame) {
    NSData *body = jsonData(frame);
    if (!body || body.length == 0 || body.length > kMaxFrameBytes) return NO;
    uint32_t length = htonl((uint32_t)body.length);
    return writeFully(fd, &length, sizeof(length)) && writeFully(fd, body.bytes, body.length);
}

static NSDictionary *readFrame(int fd) {
    uint32_t encodedLength = 0;
    if (!readFully(fd, &encodedLength, sizeof(encodedLength))) return nil;
    uint32_t length = ntohl(encodedLength);
    if (length == 0 || length > kMaxFrameBytes) return nil;
    NSMutableData *body = [NSMutableData dataWithLength:length];
    if (!readFully(fd, body.mutableBytes, length)) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:body options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static NSDictionary *validateRequest(NSDictionary *envelope, NSString *secret, NSString **requestId) {
    NSNumber *version = envelope[@"version"];
    NSString *candidateRequestId = envelope[@"requestId"];
    NSNumber *issuedAt = envelope[@"issuedAt"];
    NSString *payload = envelope[@"payload"];
    NSString *signature = envelope[@"signature"];
    if (![version isKindOfClass:[NSNumber class]] || version.integerValue != 1 || ![candidateRequestId isKindOfClass:[NSString class]] || candidateRequestId.length < 16 || ![issuedAt isKindOfClass:[NSNumber class]] || ![payload isKindOfClass:[NSString class]] || ![signature isKindOfClass:[NSString class]] || secret.length < 32) return nil;
    if (fabs([[NSDate date] timeIntervalSince1970] - issuedAt.doubleValue) > 120) return nil;
    NSString *message = [NSString stringWithFormat:@"dkrypt-autoinstall-agent-v1|%@|%@|%@", candidateRequestId, issuedAt, payload];
    if (!constantTimeEqual(hmacHex(secret, message), signature)) return nil;
    NSData *payloadData = base64URLDecode(payload);
    id value = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if (![value isKindOfClass:[NSDictionary class]]) return nil;
    *requestId = candidateRequestId;
    return value;
}

static NSDictionary *runCommand(NSString *command, NSInteger timeoutMs) {
    if (command.length == 0) return @{ @"stdout": @"", @"stderr": @"command is required", @"code": @1 };
    timeoutMs = MIN(MAX(timeoutMs > 0 ? timeoutMs : 10000, 1), 120000);
    int outputPipe[2];
    if (pipe(outputPipe) != 0) return @{ @"stdout": @"", @"stderr": @"could not create output pipe", @"code": @1 };
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, outputPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, outputPipe[1], STDERR_FILENO);
    posix_spawn_file_actions_addclose(&actions, outputPipe[0]);
    posix_spawn_file_actions_addclose(&actions, outputPipe[1]);
    pid_t pid = 0;
    NSString *script = [NSString stringWithFormat:@"export PATH=/var/jb/usr/bin:/var/jb/usr/sbin:/usr/bin:/usr/sbin:/bin:/sbin; %@", command];
    char *arguments[] = { (char *)"sh", (char *)"-c", (char *)script.UTF8String, NULL };
    int spawnStatus = posix_spawn(&pid, "/var/jb/usr/bin/sh", &actions, NULL, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    close(outputPipe[1]);
    if (spawnStatus != 0) {
        close(outputPipe[0]);
        return @{ @"stdout": @"", @"stderr": [NSString stringWithFormat:@"could not start command: %d", spawnStatus], @"code": @1 };
    }
    int flags = fcntl(outputPipe[0], F_GETFL, 0);
    fcntl(outputPipe[0], F_SETFL, flags | O_NONBLOCK);
    NSMutableData *output = [NSMutableData data];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(double)timeoutMs / 1000.0];
    int status = 0;
    BOOL timedOut = NO;
    while (YES) {
        struct pollfd descriptor = { outputPipe[0], POLLIN, 0 };
        poll(&descriptor, 1, 50);
        uint8_t buffer[8192];
        ssize_t count = read(outputPipe[0], buffer, sizeof(buffer));
        if (count > 0) {
            [output appendBytes:buffer length:(NSUInteger)count];
            if (output.length > 16u * 1024u * 1024u) [output replaceBytesInRange:NSMakeRange(0, output.length - 16u * 1024u * 1024u) withBytes:NULL length:0];
        }
        pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == pid) break;
        if ([[NSDate date] compare:deadline] == NSOrderedDescending) {
            timedOut = YES;
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            break;
        }
    }
    fcntl(outputPipe[0], F_SETFL, flags & ~O_NONBLOCK);
    while (YES) {
        uint8_t buffer[8192];
        ssize_t count = read(outputPipe[0], buffer, sizeof(buffer));
        if (count <= 0) break;
        [output appendBytes:buffer length:(NSUInteger)count];
        if (output.length > 16u * 1024u * 1024u) [output replaceBytesInRange:NSMakeRange(0, output.length - 16u * 1024u * 1024u) withBytes:NULL length:0];
    }
    close(outputPipe[0]);
    NSString *text = [[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding] ?: @"";
    NSInteger exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    if (timedOut) return @{ @"stdout": text, @"stderr": @"command timed out", @"code": [NSNull null] };
    return @{ @"stdout": text, @"stderr": @"", @"code": @(exitCode) };
}

static BOOL handleConnection(int fd) {
    NSString *secret = readSecret();
    NSMutableArray<NSString *> *replayOrder = [NSMutableArray array];
    NSMutableSet<NSString *> *replaySet = [NSMutableSet set];
    while (YES) {
        @autoreleasepool {
            NSDictionary *envelope = readFrame(fd);
            if (!envelope) return YES;
            if ([envelope[@"action"] isEqualToString:@"bootstrap"]) {
                NSString *candidate = envelope[@"secret"];
                NSString *requestId = envelope[@"requestId"];
                if (![candidate isKindOfClass:[NSString class]] || candidate.length < 32 || ![requestId isKindOfClass:[NSString class]] || requestId.length < 16) return NO;
                if (secret.length < 32) {
                    NSData *secretData = [candidate dataUsingEncoding:NSUTF8StringEncoding];
                    if (![secretData writeToFile:kSecretPath options:NSDataWritingAtomic error:nil]) return NO;
                    chmod(kSecretPath.UTF8String, 0600);
                    secret = candidate;
                } else if (!constantTimeEqual(secret, candidate)) {
                    if (!sendFrame(fd, bootstrapResponse(requestId, NO, @"secret_mismatch"))) return NO;
                    return NO;
                }
                if (!sendFrame(fd, bootstrapResponse(requestId, YES, nil))) return NO;
                continue;
            }
            if (secret.length < 32) return NO;
            NSString *requestId = nil;
            NSDictionary *request = validateRequest(envelope, secret, &requestId);
            if (!request) return NO;
            if ([replaySet containsObject:requestId]) {
                if (!sendFrame(fd, signedResponse(secret, requestId, NO, nil, @{ @"code": @"replay", @"message": @"request id was already processed" }))) return NO;
                continue;
            }
            [replaySet addObject:requestId];
            [replayOrder addObject:requestId];
            if (replayOrder.count > kMaxReplayEntries) {
                [replaySet removeObject:replayOrder.firstObject];
                [replayOrder removeObjectAtIndex:0];
            }
            NSString *action = request[@"action"];
            NSDictionary *response = nil;
            if ([action isEqualToString:@"status"]) {
                response = signedResponse(secret, requestId, YES, @{ @"agentVersion": kAgentVersion, @"port": @(kPort) }, nil);
            } else if ([action isEqualToString:@"exec"]) {
                NSString *command = [request[@"command"] isKindOfClass:[NSString class]] ? request[@"command"] : @"";
                NSInteger timeoutMs = [request[@"timeoutMs"] respondsToSelector:@selector(integerValue)] ? [request[@"timeoutMs"] integerValue] : 10000;
                response = signedResponse(secret, requestId, YES, runCommand(command, timeoutMs), nil);
            } else {
                response = signedResponse(secret, requestId, NO, nil, @{ @"code": @"unsupported", @"message": @"unsupported device agent action" });
            }
            if (!sendFrame(fd, response)) return NO;
        }
    }
}

int main(int argc, char **argv) {
    @autoreleasepool {
        int server = socket(AF_INET, SOCK_STREAM, 0);
        if (server < 0) return 1;
        int reuse = 1;
        setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        struct sockaddr_in address = {0};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(kPort);
        if (bind(server, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(server, 4) != 0) {
            close(server);
            return 1;
        }
        NSLog(@"[autoinstall-device-agent] version %@ listening on 127.0.0.1:%u", kAgentVersion, kPort);
        while (YES) {
            int client = accept(server, NULL, NULL);
            if (client < 0) {
                if (errno == EINTR) continue;
                break;
            }
            struct timeval receiveTimeout = { kClientReceiveTimeoutSeconds, 0 };
            struct timeval sendTimeout = { kClientSendTimeoutSeconds, 0 };
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &receiveTimeout, sizeof(receiveTimeout));
            setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, sizeof(sendTimeout));
            dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                @autoreleasepool {
                    handleConnection(client);
                    close(client);
                }
            });
        }
        close(server);
    }
    return 0;
}
