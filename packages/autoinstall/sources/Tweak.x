#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CommonCrypto/CommonHMAC.h>
#import <dlfcn.h>
#import <objc/runtime.h>

@protocol TFNetworkManagerProtocol <NSObject>
+ (instancetype)shared;
- (id)enqueueDataTaskWithURL:(NSURL *)url completionHandler:(void (^)(id response))completionHandler;
@end

@protocol TFNetworkManagerResponseProtocol <NSObject>
- (id)data;
- (NSError *)error;
- (NSInteger)statusCode;
@end

@protocol TFAppCatalogManagerProtocol <NSObject>
- (id)getAppCatalogCachedAppForAppID:(id)appID;
@end

@protocol TFAppBuildProtocol <NSObject>
+ (instancetype)buildFromDictionary:(NSDictionary *)dict;
@end

@protocol TFInstallableBundleProtocol <NSObject>
- (instancetype)initWithApp:(id)app build:(id)build buildGroup:(id)buildGroup preinstalledState:(NSInteger)preinstalledState parentInstalledState:(NSInteger)parentInstalledState canAutoUpdate:(BOOL)canAutoUpdate allowReinstallSameVersion:(BOOL)allowReinstallSameVersion variant:(id)variant;
@end

@protocol TFAppInstallerProtocol <NSObject>
- (id)requestInstall:(id)installable installationMode:(id)mode alertDelegate:(id)delegate withBackgroundTaskMaster:(id)master completionBlock:(id)block;
@end

@protocol TFInstallationModeProtocol <NSObject>
+ (id)modeWithUserInitiated:(BOOL)userInitiated interactive:(BOOL)interactive autoUpdate:(BOOL)autoUpdate;
@end

@protocol TFInstallAlertDelegate <NSObject>
- (BOOL)presentPrecheckAlertWithType:(NSInteger)type installable:(id)installable completion:(void (^)(BOOL))completion;
@optional
- (void)dismissPrecheckAlert;
@end

@protocol SKUIItemStateCenterProtocol <NSObject>
+ (instancetype)defaultCenter;
- (id)_newPurchasesWithItems:(NSArray *)items;
- (void)_performPurchases:(id)purchases hasBundlePurchase:(BOOL)hasBundlePurchase withClientContext:(id)context completionBlock:(void (^)(id arg1))block;
@end

@protocol SKUIItemProtocol <NSObject>
- (instancetype)initWithLookupDictionary:(NSDictionary *)dict;
@end

@protocol SKUIItemOfferProtocol <NSObject>
- (instancetype)initWithLookupDictionary:(NSDictionary *)dict;
@end

@protocol SKUIClientContextProtocol <NSObject>
+ (instancetype)defaultContext;
+ (id)_fallbackConfigurationDictionary;
- (instancetype)initWithConfigurationDictionary:(NSDictionary *)dict;
@end

@protocol SBBacklightControllerProtocol <NSObject>
+ (instancetype)sharedInstance;
- (BOOL)screenIsOn;
- (BOOL)screenIsDim;
- (NSInteger)backlightState;
- (void)preventIdleSleep;
- (void)allowIdleSleep;
@end

@protocol BrightnessSystemClientProtocol <NSObject>
- (instancetype)init;
- (id)copyPropertyForKey:(NSString *)key;
- (BOOL)setProperty:(id)value forKey:(NSString *)key;
@end

static void autoinstallLog(NSString *line) {
    NSString *path = @"/tmp/autoinstall.log";
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss.SSS";
    NSString *entry = [NSString stringWithFormat:@"[%@] %@\n", [formatter stringFromDate:[NSDate date]], line];

    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
        [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
    }

    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
    [handle seekToEndOfFile];
    [handle writeData:[entry dataUsingEncoding:NSUTF8StringEncoding]];
    [handle closeFile];
}

static NSString * const kBridgeRootPath = @"/tmp/autoinstall/v1";
static NSString * const kBridgeSecretPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-bridge.secret";

static void writeJSONFile(NSString *path, id obj) {
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingPrettyPrinted error:&err];
    if (!data) {
        data = [[NSString stringWithFormat:@"{\"ok\":false,\"error\":\"serialize failed: %@\"}", err] dataUsingEncoding:NSUTF8StringEncoding];
    }
    [data writeToFile:path atomically:YES];
}

static void writeBridgeResponse(NSString *path, NSString *requestId, id obj) {
    if ([obj isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *response = [obj mutableCopy];
        response[@"requestId"] = requestId;
        writeJSONFile(path, response);
        return;
    }
    writeJSONFile(path, obj);
}

static NSDictionary *readJSONFile(NSString *path) {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [json isKindOfClass:[NSDictionary class]] ? json : nil;
}

static void writeBridgeError(NSString *path, NSString *code, NSString *stage, NSString *message, BOOL retryable) {
    writeJSONFile(path, @{
        @"ok": @NO,
        @"error": @{
            @"code": code,
            @"stage": stage,
            @"message": message,
            @"retryable": @(retryable),
        },
    });
}

static NSString *bridgeDirectory(NSString *channel, NSString *kind) {
    return [NSString stringWithFormat:@"%@/%@/%@", kBridgeRootPath, channel, kind];
}

static NSDictionary *readJSONFile(NSString *path);

static NSString *bridgeTransactionPath(NSString *channel, NSString *operationId) {
    return [[bridgeDirectory(channel, @"transactions") stringByAppendingPathComponent:operationId] stringByAppendingPathExtension:@"json"];
}

static NSDictionary *readBridgeTransaction(NSString *channel, NSString *operationId) {
    return readJSONFile(bridgeTransactionPath(channel, operationId));
}

static void writeBridgeTransaction(NSString *channel, NSString *operationId, NSString *state, NSDictionary *fields) {
    NSString *directory = bridgeDirectory(channel, @"transactions");
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    NSMutableDictionary *transaction = [fields mutableCopy] ?: [NSMutableDictionary dictionary];
    transaction[@"operationId"] = operationId;
    transaction[@"state"] = state;
    transaction[@"updatedAt"] = @([[NSDate date] timeIntervalSince1970]);
    writeJSONFile(bridgeTransactionPath(channel, operationId), transaction);
}

static NSString *bridgeHMAC(NSString *secret, NSString *channel, NSString *requestId, NSNumber *issuedAt, NSString *payload) {
    NSString *message = [NSString stringWithFormat:@"1|%@|%@|%@|%@", channel, requestId, issuedAt, payload];
    NSData *messageData = [message dataUsingEncoding:NSUTF8StringEncoding];
    NSData *secretData = [secret dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, secretData.bytes, secretData.length, messageData.bytes, messageData.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    return hex;
}

static NSData *decodeBase64URL(NSString *value) {
    NSString *standard = [[value stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
    while (standard.length % 4) standard = [standard stringByAppendingString:@"="];
    return [[NSData alloc] initWithBase64EncodedString:standard options:0];
}

static NSDictionary *validatedBridgeRequest(NSDictionary *envelope, NSString *channel, NSString **requestId, NSString **error) {
    NSNumber *version = envelope[@"version"];
    NSString *candidateRequestId = envelope[@"requestId"];
    NSNumber *issuedAt = envelope[@"issuedAt"];
    NSString *payload = envelope[@"payload"];
    NSString *signature = envelope[@"signature"];
    NSString *secret = [[NSString stringWithContentsOfFile:kBridgeSecretPath encoding:NSUTF8StringEncoding error:nil] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (![version isKindOfClass:[NSNumber class]] || version.integerValue != 1 || ![[NSUUID alloc] initWithUUIDString:candidateRequestId] || ![issuedAt isKindOfClass:[NSNumber class]] || ![payload isKindOfClass:[NSString class]] || ![signature isKindOfClass:[NSString class]] || secret.length < 32) {
        *error = @"invalid authenticated bridge envelope";
        return nil;
    }
    if (fabs([[NSDate date] timeIntervalSince1970] - issuedAt.doubleValue) > 120) {
        *error = @"authenticated bridge envelope expired";
        return nil;
    }
    if (![bridgeHMAC(secret, channel, candidateRequestId, issuedAt, payload) isEqualToString:signature]) {
        *error = @"authenticated bridge envelope signature did not match";
        return nil;
    }
    NSData *payloadData = decodeBase64URL(payload);
    id decoded = payloadData ? [NSJSONSerialization JSONObjectWithData:payloadData options:0 error:nil] : nil;
    if (![decoded isKindOfClass:[NSDictionary class]]) {
        *error = @"authenticated bridge payload was not an object";
        return nil;
    }
    NSMutableDictionary *request = [decoded mutableCopy];
    request[@"requestId"] = candidateRequestId;
    *requestId = candidateRequestId;
    return request;
}

static void writeBridgeHeartbeat(NSString *channel) {
    static NSMutableDictionary<NSString *, NSNumber *> *lastWritten = nil;
    if (!lastWritten) lastWritten = [NSMutableDictionary dictionary];
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    if (now - lastWritten[channel].doubleValue < 30) return;
    NSString *directory = bridgeDirectory(channel, @"state");
    [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    writeJSONFile([directory stringByAppendingPathComponent:@"heartbeat.json"], @{
        @"bridgeVersion": BRIDGE_VERSION,
        @"channel": channel,
        @"process": [[NSProcessInfo processInfo] processName],
        @"at": @(now),
    });
    lastWritten[channel] = @(now);
}

static void sweepBridgeArtifacts(NSString *channel) {
    static NSMutableDictionary<NSString *, NSNumber *> *lastSwept = nil;
    if (!lastSwept) lastSwept = [NSMutableDictionary dictionary];
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    if (now - lastSwept[channel].doubleValue < 30) return;
    lastSwept[channel] = @(now);
    NSFileManager *fm = [NSFileManager defaultManager];
    NSDate *cutoff = [NSDate dateWithTimeIntervalSinceNow:-1800];
    for (NSString *kind in @[@"requests", @"responses", @"transactions"]) {
        NSString *directory = bridgeDirectory(channel, kind);
        [fm createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
        for (NSString *name in [fm contentsOfDirectoryAtPath:directory error:nil] ?: @[]) {
            NSString *file = [directory stringByAppendingPathComponent:name];
            NSDate *modified = [fm attributesOfItemAtPath:file error:nil][NSFileModificationDate];
            if ([modified compare:cutoff] == NSOrderedAscending && [fm removeItemAtPath:file error:nil]) {
                autoinstallLog([NSString stringWithFormat:@"%@-bridge: removed stale artifact %@", channel, name]);
            }
        }
    }
}

static void processSecureBridgeRequests(NSString *channel, void (^handler)(NSDictionary *request, NSString *responsePath, NSString *requestId)) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *requests = bridgeDirectory(channel, @"requests");
    NSString *responses = bridgeDirectory(channel, @"responses");
    [fm createDirectoryAtPath:requests withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    [fm createDirectoryAtPath:responses withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    for (NSString *name in [[fm contentsOfDirectoryAtPath:requests error:nil] sortedArrayUsingSelector:@selector(compare:)] ?: @[]) {
        if (![name hasSuffix:@".json"]) continue;
        NSString *requestPath = [requests stringByAppendingPathComponent:name];
        NSData *data = [NSData dataWithContentsOfFile:requestPath];
        [fm removeItemAtPath:requestPath error:nil];
        id envelope = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSString *candidateRequestId = [envelope isKindOfClass:[NSDictionary class]] && [envelope[@"requestId"] isKindOfClass:[NSString class]] ? envelope[@"requestId"] : nil;
        NSString *requestId = nil;
        NSString *error = nil;
        NSDictionary *request = [envelope isKindOfClass:[NSDictionary class]] ? validatedBridgeRequest(envelope, channel, &requestId, &error) : nil;
        NSString *responseId = requestId ?: candidateRequestId;
        NSString *responsePath = responseId.length ? [responses stringByAppendingPathComponent:[NSString stringWithFormat:@"%@.response.json", responseId]] : nil;
        if (!request) {
            if (responsePath) {
                writeBridgeResponse(responsePath, responseId, @{@"ok": @NO, @"error": error ?: @"invalid authenticated bridge request"});
            }
            continue;
        }
        handler(request, responsePath, requestId);
    }
}

static void rejectLegacyBridgeRequest(NSDictionary *request, NSString *responsePath) {
    writeBridgeError(responsePath, @"protocol_upgrade_required", @"authentication", @"use the authenticated autoinstall bridge protocol", NO);
}

@interface AutoinstallPrecheckDelegate : NSObject <TFInstallAlertDelegate>
@end

@implementation AutoinstallPrecheckDelegate

- (BOOL)presentPrecheckAlertWithType:(NSInteger)type installable:(id)installable completion:(void (^)(BOOL))completion {
    autoinstallLog([NSString stringWithFormat:@"install: approving precheck alert type=%ld installable=%@", (long)type, installable]);
    completion(YES);
    return YES;
}

- (void)dismissPrecheckAlert {}

@end

static BOOL isSpringBoard(void) {
    return [[[NSBundle mainBundle] bundleIdentifier] isEqualToString:@"com.apple.springboard"];
}

#pragma mark - SpringBoard side: SSH-toggleable dark-but-awake state + launch-on-demand

static NSString * const kDarkFlagPath = @"/var/mobile/Library/Preferences/dev.adrian.autoinstall-dark.flag";
static NSString * const kSBRequestPath = @"/tmp/autoinstall-sb-request.json";
static NSString * const kSBResponsePath = @"/tmp/autoinstall-sb-response.json";

typedef int (*SBSLaunchFn)(CFStringRef, unsigned char);

static int sbsLaunchApplication(NSString *bundleId) {
    void *sbs = dlopen("/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices", RTLD_NOW);
    if (!sbs) return -1;
    SBSLaunchFn fn = (SBSLaunchFn)dlsym(sbs, "SBSLaunchApplicationWithIdentifier");
    if (!fn) return -1;
    return fn((__bridge CFStringRef)bundleId, 0);
}

static id getIvarObject(id instance, const char *ivarName) {
    if (!instance) return nil;
    Ivar ivar = class_getInstanceVariable([instance class], ivarName);
    if (!ivar) return nil;
    return object_getIvar(instance, ivar);
}

static BOOL respondsToSelectorSafe(id object, SEL selector) {
    return object != nil && [object respondsToSelector:selector];
}

static id<SBBacklightControllerProtocol> backlightController(void) {
    Class<SBBacklightControllerProtocol> backlightCls = (Class<SBBacklightControllerProtocol>)objc_getClass("SBBacklightController");
    if (!respondsToSelectorSafe((id)backlightCls, @selector(sharedInstance))) return nil;
    return [backlightCls sharedInstance];
}

static id<BrightnessSystemClientProtocol> brightnessClient(void) {
    id backlight = backlightController();
    return getIvarObject(backlight, "_brightnessSystemClient");
}

static BOOL setBrightnessFactor(NSNumber *factor) {
    id<BrightnessSystemClientProtocol> bsc = brightnessClient();
    if (!bsc) {
        autoinstallLog(@"setBrightnessFactor: _brightnessSystemClient not found");
        return NO;
    }
    if (!respondsToSelectorSafe(bsc, @selector(setProperty:forKey:))) {
        autoinstallLog(@"setBrightnessFactor: setProperty:forKey: unavailable");
        return NO;
    }
    BOOL result = [bsc setProperty:factor forKey:@"DisplayBrightnessFactor"];
    autoinstallLog([NSString stringWithFormat:@"setBrightnessFactor: DisplayBrightnessFactor=%@ result=%d", factor, result]);
    return result;
}

static BOOL applyDark(void) {
    @try {
        id backlight = backlightController();
        if (respondsToSelectorSafe(backlight, @selector(preventIdleSleep))) {
            [backlight preventIdleSleep];
        } else {
            autoinstallLog(@"applyDark: preventIdleSleep unavailable");
        }
        BOOL result = setBrightnessFactor(@(0));
        autoinstallLog([NSString stringWithFormat:@"applyDark: DisplayBrightnessFactor=0 result=%d", result]);
        return result;
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"applyDark: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        return NO;
    }
}

static BOOL removeDark(void) {
    @try {
        BOOL result = setBrightnessFactor(@(1));
        id backlight = backlightController();
        if (respondsToSelectorSafe(backlight, @selector(allowIdleSleep))) {
            [backlight allowIdleSleep];
        } else {
            autoinstallLog(@"removeDark: allowIdleSleep unavailable");
        }
        autoinstallLog([NSString stringWithFormat:@"removeDark: DisplayBrightnessFactor=1 result=%d", result]);
        return result;
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"removeDark: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        return NO;
    }
}

static BOOL isDarkFlagSet(void) {
    return [[NSFileManager defaultManager] fileExistsAtPath:kDarkFlagPath];
}

static void setDarkFlag(BOOL on) {
    NSFileManager *fm = [NSFileManager defaultManager];
    if (on) {
        [fm createFileAtPath:kDarkFlagPath contents:[NSData data] attributes:nil];
    } else {
        [fm removeItemAtPath:kDarkFlagPath error:nil];
    }
}

static NSDictionary *screenStatusDict(void) {
    id backlight = backlightController();
    id bsc = brightnessClient();
    NSMutableDictionary *status = [@{
        @"ok": @YES,
        @"darkEnabled": @(isDarkFlagSet()),
    } mutableCopy];
    if (respondsToSelectorSafe(backlight, @selector(screenIsOn))) {
        status[@"screenIsOn"] = @([backlight screenIsOn]);
    }
    if (respondsToSelectorSafe(backlight, @selector(screenIsDim))) {
        status[@"screenIsDim"] = @([backlight screenIsDim]);
    }
    if (respondsToSelectorSafe(backlight, @selector(backlightState))) {
        status[@"backlightState"] = @([backlight backlightState]);
    }
    if (respondsToSelectorSafe(bsc, @selector(copyPropertyForKey:))) {
        id factor = [bsc copyPropertyForKey:@"DisplayBrightnessFactor"];
        status[@"brightnessFactor"] = factor ? [factor description] : [NSNull null];
    } else {
        status[@"brightnessFactor"] = [NSNull null];
    }
    return status;
}

static NSDictionary *springBoardBridgeStatus(void) {
    NSMutableDictionary *status = [screenStatusDict() mutableCopy];
    status[@"bridgeVersion"] = BRIDGE_VERSION;
    status[@"capabilities"] = @[@"dark_on", @"dark_off", @"launch_app", @"screen_status", @"status", @"protocol_v1", @"authenticated_requests", @"operation_responses", @"heartbeats", @"stale_artifact_cleanup"];
    return status;
}

static void handleSpringBoardRequest(NSDictionary *req, NSString *responsePath, NSString *requestId) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"sb-bridge: handling action=%@ req=%@", action, req]);

    @try {
        if ([action isEqualToString:@"dark_on"]) {
            BOOL applied = applyDark();
            if (applied) setDarkFlag(YES);
            NSMutableDictionary *status = [screenStatusDict() mutableCopy];
            status[@"ok"] = @(applied);
            if (!applied) status[@"error"] = @"dark mode could not be applied";
            writeBridgeResponse(responsePath, requestId, status);
            return;
        }

        if ([action isEqualToString:@"dark_off"]) {
            BOOL removed = removeDark();
            if (removed) setDarkFlag(NO);
            NSMutableDictionary *status = [screenStatusDict() mutableCopy];
            status[@"ok"] = @(removed);
            if (!removed) status[@"error"] = @"dark mode could not be disabled";
            writeBridgeResponse(responsePath, requestId, status);
            return;
        }

        if ([action isEqualToString:@"launch_app"]) {
            NSString *bundleId = req[@"bundleId"];
            if (!bundleId) {
                writeBridgeResponse(responsePath, requestId, @{@"ok": @NO, @"error": @"missing bundleId"});
                return;
            }
            if (isDarkFlagSet()) applyDark();
            int rc = sbsLaunchApplication(bundleId);
            autoinstallLog([NSString stringWithFormat:@"launch_app: SBSLaunchApplicationWithIdentifier(%@)=%d", bundleId, rc]);
            NSMutableDictionary *resp = [screenStatusDict() mutableCopy];
            resp[@"ok"] = rc == 0 ? @YES : @NO;
            resp[@"launchResult"] = @(rc);
            writeBridgeResponse(responsePath, requestId, resp);
            return;
        }

        if ([action isEqualToString:@"screen_status"] || [action isEqualToString:@"status"]) {
            writeBridgeResponse(responsePath, requestId, springBoardBridgeStatus());
            return;
        }

        writeBridgeResponse(responsePath, requestId, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"sb-bridge: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        writeBridgeResponse(responsePath, requestId, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
    }
}

static dispatch_queue_t gSBBridgeQueue = nil;
static dispatch_source_t gSBBridgeTimer = nil;

static void startSpringBoardSide(void) {
    gSBBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.sb-bridge", DISPATCH_QUEUE_SERIAL);
    gSBBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gSBBridgeQueue);
    dispatch_source_set_timer(gSBBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gSBBridgeTimer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
        writeBridgeHeartbeat(@"springboard");
        sweepBridgeArtifacts(@"springboard");
        processSecureBridgeRequests(@"springboard", ^(NSDictionary *request, NSString *responsePath, NSString *requestId) {
            handleSpringBoardRequest(request, responsePath, requestId);
        });
        if (![fm fileExistsAtPath:kSBRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kSBRequestPath];
        [fm removeItemAtPath:kSBRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            autoinstallLog([NSString stringWithFormat:@"sb-bridge: bad request json: %@", err]);
            return;
        }
        rejectLegacyBridgeRequest(req, kSBResponsePath);
    });
    dispatch_resume(gSBBridgeTimer);
    autoinstallLog(@"sb-bridge: request-file watcher started");

    if (isDarkFlagSet()) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), gSBBridgeQueue, ^{
            autoinstallLog(@"sb: dark flag set, re-applying dark state (deferred 15s past boot)");
            applyDark();
        });
    }
}

#pragma mark - TestFlight side: list / install bridge

static id gInstaller = nil;
static id gCatalogManager = nil;
static UIBackgroundTaskIdentifier gBackgroundTaskId = 0;
static AutoinstallPrecheckDelegate *gPrecheckDelegate = nil;

static void beginBackgroundKeepAlive(void) {
    if (gBackgroundTaskId != UIBackgroundTaskInvalid) return;
    gBackgroundTaskId = [[UIApplication sharedApplication] beginBackgroundTaskWithName:@"autoinstall-install" expirationHandler:^{
        autoinstallLog([NSString stringWithFormat:@"background task %lu expired", (unsigned long)gBackgroundTaskId]);
        [[UIApplication sharedApplication] endBackgroundTask:gBackgroundTaskId];
        gBackgroundTaskId = UIBackgroundTaskInvalid;
    }];
    autoinstallLog([NSString stringWithFormat:@"began background task id=%lu remaining=%f", (unsigned long)gBackgroundTaskId,
        [[UIApplication sharedApplication] backgroundTimeRemaining]]);
}

static void endBackgroundKeepAlive(void) {
    if (gBackgroundTaskId == UIBackgroundTaskInvalid) return;
    autoinstallLog([NSString stringWithFormat:@"ending background task id=%lu", (unsigned long)gBackgroundTaskId]);
    [[UIApplication sharedApplication] endBackgroundTask:gBackgroundTaskId];
    gBackgroundTaskId = UIBackgroundTaskInvalid;
}

%hook TFAppCatalogManager

- (id)initWithNetworkManager:(id)networkManager nanoDeviceConnection:(id)nanoDeviceConnection {
    id result = %orig;
    gCatalogManager = result;
    return result;
}

- (id)initWithAppCatalog:(id)appCatalog networkManager:(id)networkManager nanoDeviceConnection:(id)nanoDeviceConnection {
    id result = %orig;
    gCatalogManager = result;
    return result;
}

%end

%hook TFAppInstaller

+ (id)installerWithInstallManager:(id)installManager nanoInstallManager:(id)nanoInstallManager {
    id result = %orig;
    gInstaller = result;
    return result;
}

- (id)initWithInstallManager:(id)installManager nanoInstallManager:(id)nanoInstallManager {
    id result = %orig;
    gInstaller = result;
    return result;
}

%end

static NSString * const kRequestPath = @"/tmp/autoinstall-request.json";
static NSString * const kResponsePath = @"/tmp/autoinstall-response.json";
static NSString * const kInstallStatusPath = @"/tmp/autoinstall-install-status.json";

static NSDictionary *bridgeStatus(void) {
    return @{
        @"bridgeVersion": BRIDGE_VERSION,
        @"capabilities": @[@"list_trains", @"list_builds", @"install", @"status", @"diagnostics", @"idempotent_install", @"protocol_v1", @"authenticated_requests", @"operation_responses", @"heartbeats", @"stale_artifact_cleanup"],
        @"hasInstaller": gInstaller ? @YES : @NO,
        @"hasCatalogManager": gCatalogManager ? @YES : @NO,
        @"backgroundTaskActive": gBackgroundTaskId != UIBackgroundTaskInvalid ? @YES : @NO,
        @"backgroundTimeRemaining": @([[UIApplication sharedApplication] backgroundTimeRemaining]),
    };
}

static NSArray<NSString *> *recentBridgeLogEntries(void) {
    NSString *log = [NSString stringWithContentsOfFile:@"/tmp/autoinstall.log" encoding:NSUTF8StringEncoding error:nil];
    if (!log.length) return @[];
    NSArray<NSString *> *lines = [log componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]];
    NSUInteger start = lines.count > 20 ? lines.count - 20 : 0;
    NSMutableArray<NSString *> *recent = [NSMutableArray array];
    for (NSUInteger index = start; index < lines.count; index++) {
        NSString *line = lines[index];
        if (line.length) [recent addObject:line];
    }
    return recent;
}

static NSString *networkErrorDescription(id error) {
    if ([error respondsToSelector:@selector(localizedDescription)]) {
        return [error localizedDescription];
    }
    return [NSString stringWithFormat:@"%@", error];
}

static void fetchJSON(NSString *urlString, void (^completion)(id json, NSDictionary *error)) {
    NSURL *url = [NSURL URLWithString:urlString];
    Class<TFNetworkManagerProtocol> cls = (Class<TFNetworkManagerProtocol>)objc_getClass("TFNetworkManager");
    id<TFNetworkManagerProtocol> manager = [cls shared];

    [manager enqueueDataTaskWithURL:url completionHandler:^(id response) {
        @try {
            id<TFNetworkManagerResponseProtocol> typedResponse = response;
            NSError *error = [typedResponse error];
            id data = [typedResponse data];
            if (error) {
                completion(nil, @{
                    @"code": @"network_request_failed",
                    @"stage": @"metadata_fetch",
                    @"message": networkErrorDescription(error),
                    @"retryable": @YES,
                });
                return;
            }
            if (!data) {
                completion(nil, @{
                    @"code": @"missing_response_data",
                    @"stage": @"metadata_fetch",
                    @"message": @"no data in response",
                    @"retryable": @YES,
                });
                return;
            }
            completion(data, nil);
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"fetchJSON: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            completion(nil, @{
                @"code": @"metadata_exception",
                @"stage": @"metadata_fetch",
                @"message": [NSString stringWithFormat:@"exception: %@", exception.reason],
                @"retryable": @YES,
            });
        }
    }];
}

static void handleRequest(NSDictionary *req, NSString *responsePath, NSString *requestId) {
    void (^respond)(id) = ^(id response) { writeBridgeResponse(responsePath, requestId, response); };
    void (^fail)(NSString *, NSString *, NSString *, BOOL) = ^(NSString *code, NSString *stage, NSString *message, BOOL retryable) {
        respond(@{@"ok": @NO, @"error": @{@"code": code, @"stage": stage, @"message": message, @"retryable": @(retryable)}});
    };
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"install"]) {
        @try {
            NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
            NSDictionary *previousStatus = readBridgeTransaction(@"testflight", operationId);
            if ([previousStatus[@"operationId"] isEqual:operationId]) {
                BOOL completed = [previousStatus[@"state"] isEqualToString:@"completed"];
                respond(@{@"ok": @YES, @"requested": @(!completed), @"resumed": @YES, @"completed": @(completed), @"operationId": operationId});
                return;
            }

            if (!gCatalogManager) {
                fail(@"catalog_unavailable", @"install", @"gCatalogManager not stashed yet", YES);
                return;
            }
            if (!gInstaller) {
                fail(@"installer_unavailable", @"install", @"gInstaller not stashed yet", YES);
                return;
            }

            NSNumber *appId = req[@"appId"];
            NSDictionary *buildDict = req[@"build"];
            if (!appId || !buildDict) {
                fail(@"invalid_request", @"install", @"missing appId or build", NO);
                return;
            }
            beginBackgroundKeepAlive();
            id<TFAppCatalogManagerProtocol> catalogManager = gCatalogManager;
            id app = [catalogManager getAppCatalogCachedAppForAppID:appId];
            if (!app) {
                fail(@"app_not_cached", @"install", @"getAppCatalogCachedAppForAppID: returned nil - is the catalog populated?", YES);
                return;
            }

            Class<TFAppBuildProtocol> buildCls = (Class<TFAppBuildProtocol>)objc_getClass("TFAppBuild");
            id build = [buildCls buildFromDictionary:buildDict];
            if (!build) {
                fail(@"invalid_build", @"install", @"buildFromDictionary: returned nil", NO);
                return;
            }

            id bundleAlloc = [objc_getClass("TFInstallableBundle") alloc];
            id installable = [(id<TFInstallableBundleProtocol>)bundleAlloc initWithApp:app
                                                        build:build
                                                   buildGroup:nil
                                            preinstalledState:0
                                        parentInstalledState:0
                                                canAutoUpdate:NO
                                    allowReinstallSameVersion:YES
                                                      variant:nil];
            if (!installable) {
                fail(@"installable_unavailable", @"install", @"initWithApp:build:... returned nil", YES);
                return;
            }

            autoinstallLog([NSString stringWithFormat:@"install: installable=%@", installable]);
            void (^completion)(void) = ^{
                autoinstallLog(@"install: completionBlock fired");
                writeBridgeTransaction(@"testflight", operationId, @"completed", @{@"ok": @YES, @"appId": appId, @"bundleId": buildDict[@"bundleId"] ?: [NSNull null], @"buildVersion": buildDict[@"cfBundleVersion"] ?: [NSNull null]});
                writeJSONFile(kInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"completed", @"appId": appId});
            };
            id<TFAppInstallerProtocol> installer = gInstaller;
            if (!gPrecheckDelegate) gPrecheckDelegate = [AutoinstallPrecheckDelegate new];
            Class<TFInstallationModeProtocol> modeClass = (Class<TFInstallationModeProtocol>)objc_getClass("TFInstallationMode");
            id mode = [modeClass modeWithUserInitiated:YES interactive:YES autoUpdate:NO];
            if (!mode) {
                fail(@"installation_mode_unavailable", @"install", @"TFInstallationMode did not create an interactive user-initiated mode", YES);
                return;
            }
            NSDictionary *transaction = @{@"ok": @YES, @"appId": appId, @"bundleId": buildDict[@"bundleId"] ?: [NSNull null], @"buildVersion": buildDict[@"cfBundleVersion"] ?: [NSNull null]};
            writeBridgeTransaction(@"testflight", operationId, @"requested", transaction);
            writeJSONFile(kInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"appId": appId});
            id result = [installer requestInstall:installable installationMode:mode alertDelegate:gPrecheckDelegate withBackgroundTaskMaster:nil completionBlock:completion];
            autoinstallLog([NSString stringWithFormat:@"install: requestInstall: returned %@", result]);
            respond(@{@"ok": @YES, @"requested": @YES, @"operationId": operationId});
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            fail(@"install_exception", @"install", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
        }
        return;
    }

    if ([action isEqualToString:@"list_trains"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains", appId];
        fetchJSON(url, ^(id json, NSDictionary *error) {
            if (error) {
                respond(@{@"ok": @NO, @"error": error});
            } else {
                respond(@{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"list_builds"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *train = req[@"trainVersion"];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains/%@/builds", appId, train];
        fetchJSON(url, ^(id json, NSDictionary *error) {
            if (error) {
                respond(@{@"ok": @NO, @"error": error});
            } else {
                respond(@{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"status"]) {
        NSMutableDictionary *response = [bridgeStatus() mutableCopy];
        response[@"ok"] = @YES;
        response[@"install"] = readJSONFile(kInstallStatusPath) ?: @{};
        respond(response);
        return;
    }

    if ([action isEqualToString:@"diagnostics"]) {
        respond(@{
            @"ok": @YES,
            @"data": @{
                @"bridge": bridgeStatus(),
                @"install": readJSONFile(kInstallStatusPath) ?: @{},
                @"recentLog": recentBridgeLogEntries(),
            },
        });
        return;
    }

    if ([action isEqualToString:@"end_background_keepalive"]) {
        endBackgroundKeepAlive();
        respond(@{@"ok": @YES});
        return;
    }

    fail(@"unknown_action", @"request", [NSString stringWithFormat:@"unknown action: %@", action], NO);
}

static dispatch_queue_t gBridgeQueue = nil;
static dispatch_source_t gBridgeTimer = nil;

static void startTestFlightSide(void) {
    gBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.bridge", DISPATCH_QUEUE_SERIAL);
    gBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gBridgeQueue);
    dispatch_source_set_timer(gBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gBridgeTimer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
        writeBridgeHeartbeat(@"testflight");
        sweepBridgeArtifacts(@"testflight");
        processSecureBridgeRequests(@"testflight", ^(NSDictionary *request, NSString *responsePath, NSString *requestId) {
            handleRequest(request, responsePath, requestId);
        });
        if (![fm fileExistsAtPath:kRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kRequestPath];
        [fm removeItemAtPath:kRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            autoinstallLog([NSString stringWithFormat:@"bridge: bad request json: %@", err]);
            return;
        }
        rejectLegacyBridgeRequest(req, kResponsePath);
    });
    dispatch_resume(gBridgeTimer);
    autoinstallLog(@"bridge: request-file watcher started");
}

static BOOL gIsAppStoreProcess = NO;
static BOOL gIsPassbookProcess = NO;

static id gStashedConfirmVC = nil;
static BOOL gConfirmDoneThisSheet = NO;
static BOOL gConfirmAttemptActive = NO;

static void autoinstallWalkAX(id element, void (^visit)(id el)) {
    if (!element) return;
    visit(element);
    @try {
        NSArray *axKids = nil;
        if ([element respondsToSelector:@selector(accessibilityElements)]) {
            axKids = [element accessibilityElements];
        }
        if (axKids.count) {
            for (id k in axKids) autoinstallWalkAX(k, visit);
        } else if ([element respondsToSelector:@selector(accessibilityElementCount)]) {
            NSInteger n = [element accessibilityElementCount];
            if (n > 0 && n != NSNotFound) {
                for (NSInteger i = 0; i < n; i++) autoinstallWalkAX([element accessibilityElementAtIndex:i], visit);
            }
        }
        if ([element isKindOfClass:[UIView class]]) {
            for (UIView *sub in [(UIView *)element subviews]) autoinstallWalkAX(sub, visit);
        }
    } @catch (NSException *e) {}
}

static void autoinstallEnableAX(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        void *h = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW);
        if (!h) { autoinstallLog(@"AX: dlopen libAccessibility failed"); return; }
        void (*setApp)(Boolean) = (void (*)(Boolean))dlsym(h, "_AXSApplicationAccessibilitySetEnabled");
        void (*setAuto)(Boolean) = (void (*)(Boolean))dlsym(h, "_AXSSetAutomationEnabled");
        if (setApp) setApp(true);
        if (setAuto) setAuto(true);
        autoinstallLog(@"AX: automation enabled");
    });
}

static NSArray *autoinstallConfirmStashed(NSString *match) {
    NSMutableArray *acted = [NSMutableArray array];
    id root = nil;
    @try { root = gStashedConfirmVC ? [(id)gStashedConfirmVC view] : nil; } @catch (NSException *e) {}
    if (!root) return acted;
    autoinstallWalkAX(root, ^(id el) {
        NSString *label = @"";
        @try { if ([el respondsToSelector:@selector(accessibilityLabel)]) label = [el accessibilityLabel] ?: @""; } @catch (NSException *e) {}
        NSString *hay = [NSString stringWithFormat:@"%@|%@", NSStringFromClass([el class]), label];
        if ([hay rangeOfString:match options:NSCaseInsensitiveSearch].location == NSNotFound) return;
        NSMutableDictionary *rec = [@{@"class": NSStringFromClass([el class]), @"label": label} mutableCopy];
        @try {
            if ([el respondsToSelector:@selector(accessibilityActivate)]) {
                rec[@"accessibilityActivate"] = @([el accessibilityActivate]);
            }
            if ([el isKindOfClass:[UIControl class]]) {
                [(UIControl *)el sendActionsForControlEvents:UIControlEventTouchUpInside];
                rec[@"sentControlEvents"] = @YES;
            }
        } @catch (NSException *e) {
            rec[@"exception"] = [NSString stringWithFormat:@"%@ %@", e.name, e.reason];
        }
        [acted addObject:rec];
    });
    return acted;
}

static void autoinstallScheduleConfirm(NSString *match, NSUInteger attempt) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (![[NSFileManager defaultManager] fileExistsAtPath:@"/tmp/autoinstall-autoconfirm.flag"] || !gStashedConfirmVC) {
            gConfirmAttemptActive = NO;
            return;
        }

        NSArray *acted = autoinstallConfirmStashed(match);
        autoinstallLog([NSString stringWithFormat:@"[PB] auto-confirm match=%@ attempt=%lu acted=%@", match, (unsigned long)(attempt + 1), acted]);
        if (acted.count > 0 || attempt >= 12) {
            gConfirmDoneThisSheet = acted.count > 0;
            gConfirmAttemptActive = NO;
            return;
        }

        autoinstallScheduleConfirm(match, attempt + 1);
    });
}

%hook UIViewController

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (!gIsPassbookProcess) return;
    @try {
        NSString *cls = NSStringFromClass([self class]);
        if ([cls rangeOfString:@"AuthorizationViewHostingController"].location == NSNotFound) return;
        gStashedConfirmVC = self;
        autoinstallEnableAX();
        if (gConfirmDoneThisSheet || gConfirmAttemptActive) return;
        if (![[NSFileManager defaultManager] fileExistsAtPath:@"/tmp/autoinstall-autoconfirm.flag"]) return;
        gConfirmAttemptActive = YES;
        NSString *match = [NSString stringWithContentsOfFile:@"/tmp/autoinstall-autoconfirm.flag" encoding:NSUTF8StringEncoding error:nil];
        match = [match stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!match.length) match = @"Install";
        autoinstallScheduleConfirm(match, 0);
    } @catch (NSException *e) {}
}

%end

%hook PKPaymentAuthorizationRemoteAlertViewController

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (gIsPassbookProcess) {
        gConfirmDoneThisSheet = NO;
        gConfirmAttemptActive = NO;
    }
}

%end

static NSString * const kASRequestPath = @"/tmp/autoinstall-as-request.json";
static NSString * const kASResponsePath = @"/tmp/autoinstall-as-response.json";
static NSString * const kASInstallStatusPath = @"/tmp/autoinstall-as-install-status.json";

static BOOL appStoreIsForeground(void) {
    return [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
}

static NSDictionary *appStoreBridgeStatus(void) {
    return @{
        @"bridgeVersion": BRIDGE_VERSION,
        @"capabilities": @[@"install", @"status", @"diagnostics", @"foreground_status", @"protocol_v1", @"authenticated_requests", @"operation_responses", @"heartbeats", @"stale_artifact_cleanup"],
        @"foreground": @(appStoreIsForeground()),
        @"install": readJSONFile(kASInstallStatusPath) ?: @{},
    };
}

static void handleAppStoreRequest(NSDictionary *req, NSString *responsePath, NSString *requestId) {
    void (^respond)(id) = ^(id response) { writeBridgeResponse(responsePath, requestId, response); };
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"as-bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"status"]) {
        NSMutableDictionary *response = [appStoreBridgeStatus() mutableCopy];
        response[@"ok"] = @YES;
        respond(response);
        return;
    }

    if ([action isEqualToString:@"diagnostics"]) {
        respond(@{@"ok": @YES, @"data": @{ @"bridge": appStoreBridgeStatus(), @"recentLog": recentBridgeLogEntries() }});
        return;
    }

    if (![action isEqualToString:@"install"]) {
        respond(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
        return;
    }

    NSNumber *adamId = req[@"adamId"];
    NSNumber *versionId = req[@"versionId"];
    NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
    if (!adamId) {
        respond(@{@"ok": @NO, @"error": @"missing adamId"});
        return;
    }

    NSDictionary *previousStatus = readBridgeTransaction(@"appstore", operationId);
    if ([previousStatus[@"operationId"] isEqual:operationId]) {
        BOOL completed = [previousStatus[@"state"] isEqual:@"completed"];
        respond(@{@"ok": @YES, @"requested": @(!completed), @"resumed": @YES, @"completed": @(completed), @"operationId": operationId});
        return;
    }

    dispatch_sync(dispatch_get_main_queue(), ^{
        @try {
            if (!appStoreIsForeground()) {
                respond(@{
                    @"ok": @NO,
                    @"error": @{
                        @"code": @"appstore_not_foreground",
                        @"stage": @"foreground",
                        @"message": @"App Store is not active",
                        @"retryable": @YES,
                    },
                });
                return;
            }

            NSString *adamIdStr = [adamId stringValue];
            NSString *offerString;
            if (versionId && versionId.longLongValue != 0) {
                offerString = [NSString stringWithFormat:@"productType=C&price=0&salableAdamId=%@&pricingParameters=pricingParameter&appExtVrsId=%@&clientBuyId=1&installed=0&trolled=1", adamIdStr, [versionId stringValue]];
            } else {
                offerString = [NSString stringWithFormat:@"productType=C&price=0&salableAdamId=%@&pricingParameters=pricingParameter&clientBuyId=1&installed=0&trolled=1", adamIdStr];
            }

            id<SKUIItemOfferProtocol> offer = [[objc_getClass("SKUIItemOffer") alloc] initWithLookupDictionary:@{@"buyParams": offerString}];
            id<SKUIItemProtocol> item = [[objc_getClass("SKUIItem") alloc] initWithLookupDictionary:@{@"_itemOffer": adamIdStr}];
            if (!offer || !item) {
                respond(@{@"ok": @NO, @"error": @"initWithLookupDictionary: returned nil"});
                return;
            }

            [(id)item setValue:offer forKey:@"_itemOffer"];
            [(id)item setValue:@"iosSoftware" forKey:@"_itemKindString"];
            if (versionId && versionId.longLongValue != 0) {
                [(id)item setValue:versionId forKey:@"_versionIdentifier"];
            }

            Class centerCls = objc_getClass("SKUIItemStateCenter");
            Class contextCls = objc_getClass("SKUIClientContext");
            id<SKUIItemStateCenterProtocol> center = [centerCls defaultCenter];

            id<SKUIClientContextProtocol> clientContext = [contextCls defaultContext];
            if (!clientContext) {
                id fallbackConfig = [contextCls _fallbackConfigurationDictionary];
                clientContext = [[contextCls alloc] initWithConfigurationDictionary:fallbackConfig];
            }
            if (!center || !clientContext) {
                respond(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"center=%@ clientContext=%@", center, clientContext]});
                return;
            }

            id purchases = [center _newPurchasesWithItems:@[(id)item]];
            autoinstallLog([NSString stringWithFormat:@"as-install: adamId=%@ versionId=%@ purchases=%@", adamIdStr, versionId, purchases]);

            void (^completion)(id) = ^(id arg1) {
                autoinstallLog(@"as-install: completionBlock fired");
                writeBridgeTransaction(@"appstore", operationId, @"completed", @{@"ok": @YES, @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
                writeJSONFile(kASInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"completed", @"adamId": adamId});
            };

            writeBridgeTransaction(@"appstore", operationId, @"requested", @{@"ok": @YES, @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
            writeJSONFile(kASInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"adamId": adamId, @"versionId": versionId ?: [NSNull null]});
            [center _performPurchases:purchases hasBundlePurchase:NO withClientContext:(id)clientContext completionBlock:completion];
            respond(@{@"ok": @YES, @"requested": @YES, @"operationId": operationId});
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"as-install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            respond(@{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
        }
    });
}

static dispatch_queue_t gASBridgeQueue = nil;
static dispatch_source_t gASBridgeTimer = nil;

static void startAppStoreSide(void) {
    gASBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.as-bridge", DISPATCH_QUEUE_SERIAL);
    gASBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gASBridgeQueue);
    dispatch_source_set_timer(gASBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gASBridgeTimer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
        writeBridgeHeartbeat(@"appstore");
        sweepBridgeArtifacts(@"appstore");
        processSecureBridgeRequests(@"appstore", ^(NSDictionary *request, NSString *responsePath, NSString *requestId) {
            handleAppStoreRequest(request, responsePath, requestId);
        });
        if (![fm fileExistsAtPath:kASRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kASRequestPath];
        [fm removeItemAtPath:kASRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            autoinstallLog([NSString stringWithFormat:@"as-bridge: bad request json: %@", err]);
            return;
        }
        rejectLegacyBridgeRequest(req, kASResponsePath);
    });
    dispatch_resume(gASBridgeTimer);
    autoinstallLog(@"as-bridge: request-file watcher started");
}

%ctor {
    NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier];
    NSString *processName = [[NSProcessInfo processInfo] processName];
    autoinstallLog([NSString stringWithFormat:@"autoinstall loaded into pid %d bundle %@ process %@",
        [[NSProcessInfo processInfo] processIdentifier], bundleId, processName]);

    if (isSpringBoard()) {
        startSpringBoardSide();
    } else if ([bundleId isEqualToString:@"com.apple.AppStore"]) {
        gIsAppStoreProcess = YES;
        startAppStoreSide();
    } else if ([bundleId isEqualToString:@"com.apple.PassbookUIService"] || [processName isEqualToString:@"PassbookUIService"]) {
        gIsPassbookProcess = YES;
        autoinstallEnableAX();
    } else {
        startTestFlightSide();
    }
}
