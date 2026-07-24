#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <mach/mach_time.h>

#pragma mark - IOHID synthetic-touch SPI (adapted from OwnGoalStudio/TrollVNC's STHIDEventGenerator,
#pragma mark   itself derived from WebKit's IOKitSPI.h - same mechanism XCTest UI automation uses)

#ifdef __cplusplus
extern "C" {
#endif

typedef double IOHIDFloat;
enum { kIOHIDEventOptionNone = 0 };
typedef UInt32 IOOptionBits;
typedef uint32_t IOHIDEventOptionBits;
typedef uint32_t IOHIDEventField;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
typedef struct __IOHIDEvent *IOHIDEventRef;

#define IOHIDEventFieldBase(type) (type << 16)
enum { kIOHIDDigitizerEventTouch = 1 << 1, kIOHIDDigitizerEventIdentity = 1 << 5 };
typedef uint32_t IOHIDDigitizerEventMask;
enum { kIOHIDEventTypeNULL, kIOHIDEventTypeDigitizer = 11 };
typedef uint32_t IOHIDEventType;
enum { kIOHIDEventFieldIsBuiltIn = IOHIDEventFieldBase(kIOHIDEventTypeNULL) + 4 };
enum {
    kIOHIDEventFieldDigitizerX = IOHIDEventFieldBase(kIOHIDEventTypeDigitizer),
    kIOHIDEventFieldDigitizerMajorRadius = kIOHIDEventFieldDigitizerX + 20,
    kIOHIDEventFieldDigitizerMinorRadius,
    kIOHIDEventFieldDigitizerIsDisplayIntegrated = kIOHIDEventFieldDigitizerMajorRadius + 5,
};
enum { kIOHIDDigitizerTransducerTypeHand = 3 };
typedef uint32_t IOHIDDigitizerTransducerType;
#define kGSEventPathInfoInRange (1 << 0)
#define kGSEventPathInfoInTouch (1 << 1)

IOHIDEventRef IOHIDEventCreateDigitizerEvent(CFAllocatorRef, uint64_t, IOHIDDigitizerTransducerType, uint32_t, uint32_t,
                                             IOHIDDigitizerEventMask, uint32_t, IOHIDFloat, IOHIDFloat, IOHIDFloat,
                                             IOHIDFloat, IOHIDFloat, boolean_t, boolean_t, IOOptionBits);
IOHIDEventRef IOHIDEventCreateDigitizerFingerEvent(CFAllocatorRef, uint64_t, uint32_t, uint32_t,
                                                   IOHIDDigitizerEventMask, IOHIDFloat, IOHIDFloat, IOHIDFloat,
                                                   IOHIDFloat, IOHIDFloat, boolean_t, boolean_t, IOHIDEventOptionBits);
void IOHIDEventSetIntegerValue(IOHIDEventRef, IOHIDEventField, CFIndex);
void IOHIDEventSetFloatValue(IOHIDEventRef, IOHIDEventField, IOHIDFloat);
void IOHIDEventSetSenderID(IOHIDEventRef, uint64_t);
void IOHIDEventAppendEvent(IOHIDEventRef, IOHIDEventRef, IOOptionBits);
IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef);
void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef, IOHIDEventRef);

#ifdef __cplusplus
}
#endif

static IOHIDEventRef autoinstallCreateHandEvent(BOOL touching, CGPoint normalizedPoint) {
    IOHIDDigitizerEventMask eventMask = kIOHIDDigitizerEventTouch | kIOHIDDigitizerEventIdentity;
    uint64_t machTime = mach_absolute_time();

    IOHIDEventRef eventRef = IOHIDEventCreateDigitizerEvent(kCFAllocatorDefault, machTime, kIOHIDDigitizerTransducerTypeHand,
                                                            0, 0, eventMask, 0, 0, 0, 0, 0, 0, 0, touching, kIOHIDEventOptionNone);
    IOHIDEventSetIntegerValue(eventRef, kIOHIDEventFieldIsBuiltIn, 1);
    IOHIDEventSetIntegerValue(eventRef, kIOHIDEventFieldDigitizerIsDisplayIntegrated, 1);

    IOHIDFloat pathPressure = touching ? 0 : 0;
    IOHIDFloat pathMajorRadius = touching ? 5 : 0;
    uint32_t pathProximity = touching ? (kGSEventPathInfoInTouch | kGSEventPathInfoInRange) : 0;

    IOHIDEventRef subEvent = IOHIDEventCreateDigitizerFingerEvent(kCFAllocatorDefault, machTime, 2, 2, eventMask,
        normalizedPoint.x, normalizedPoint.y, 0, pathPressure, 90.0,
        (pathProximity & kGSEventPathInfoInRange) != 0, (pathProximity & kGSEventPathInfoInTouch) != 0, kIOHIDEventOptionNone);
    IOHIDEventSetFloatValue(subEvent, kIOHIDEventFieldDigitizerMinorRadius, pathMajorRadius);
    IOHIDEventSetFloatValue(subEvent, kIOHIDEventFieldDigitizerMajorRadius, pathMajorRadius);
    IOHIDEventAppendEvent(eventRef, subEvent, 0);
    CFRelease(subEvent);

    return eventRef;
}

static void autoinstallDispatchHIDEvent(IOHIDEventRef eventRef) {
    static IOHIDEventSystemClientRef client = NULL;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
    });
    IOHIDEventSetSenderID(eventRef, 0x8000000817319371);
    IOHIDEventSystemClientDispatchEvent(client, eventRef);
}

// pointInPoints is in the same unit as [UIScreen mainScreen].bounds (points, not pixels) - normalization
// only cares that numerator/denominator match units, so this avoids needing the private physical-pixel API.
static void autoinstallSynthesizeTap(CGPoint pointInPoints) {
    CGSize screenSize = [UIScreen mainScreen].bounds.size;
    CGPoint normalized = CGPointMake(pointInPoints.x / screenSize.width, pointInPoints.y / screenSize.height);

    IOHIDEventRef down = autoinstallCreateHandEvent(YES, normalized);
    autoinstallDispatchHIDEvent(down);
    CFRelease(down);

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.08 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        IOHIDEventRef up = autoinstallCreateHandEvent(NO, normalized);
        autoinstallDispatchHIDEvent(up);
        CFRelease(up);
    });
}

static NSString *autoinstallDescribeXPCInterface(NSXPCInterface *interface) {
    Protocol *proto = interface.protocol;
    NSString *protoName = proto ? NSStringFromProtocol(proto) : @"(unknown)";
    NSMutableString *methods = [NSMutableString string];
    if (proto) {
        unsigned int count = 0;
        struct objc_method_description *descs = protocol_copyMethodDescriptionList(proto, YES, YES, &count);
        for (unsigned int i = 0; i < count; i++) {
            [methods appendFormat:@"  %@\n", NSStringFromSelector(descs[i].name)];
        }
        if (descs) free(descs);
        descs = protocol_copyMethodDescriptionList(proto, NO, YES, &count);
        for (unsigned int i = 0; i < count; i++) {
            [methods appendFormat:@"  (optional) %@\n", NSStringFromSelector(descs[i].name)];
        }
        if (descs) free(descs);
    }
    return [NSString stringWithFormat:@"protocol=%@ methods:\n%@", protoName, methods];
}

@protocol TFURLSessionProtocol <NSObject>
+ (instancetype)session;
- (NSURLSessionDataTask *)dataTaskWithURL:(NSURL *)url completionHandler:(void (^)(NSData *data, NSURLResponse *response, NSError *error))completionHandler;
@end

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
- (id)requestInstall:(id)installable installationMode:(NSInteger)mode alertDelegate:(id)delegate withBackgroundTaskMaster:(id)master completionBlock:(id)block;
@end

@protocol SKUIItemStateCenterProtocol <NSObject>
+ (instancetype)defaultCenter;
- (id)_newPurchasesWithItems:(NSArray *)items;
- (void)_performPurchases:(id)purchases hasBundlePurchase:(BOOL)hasBundlePurchase withClientContext:(id)context completionBlock:(void (^)(id arg1))block;
- (void)_performSoftwarePurchases:(id)purchases withClientContext:(id)context completionBlock:(void (^)(id arg1))block;
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

@protocol LNConfirmationRequestProtocol <NSObject>
- (void)respondWithConfirmation:(BOOL)confirmed;
- (void)respondWithError:(NSError *)error;
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

static void writeJSONFile(NSString *path, id obj) {
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingPrettyPrinted error:&err];
    if (!data) {
        data = [[NSString stringWithFormat:@"{\"ok\":false,\"error\":\"serialize failed: %@\"}", err] dataUsingEncoding:NSUTF8StringEncoding];
    }
    [data writeToFile:path atomically:YES];
}

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

static id<BrightnessSystemClientProtocol> brightnessClient(void) {
    Class<SBBacklightControllerProtocol> backlightCls = (Class<SBBacklightControllerProtocol>)objc_getClass("SBBacklightController");
    id backlight = [backlightCls sharedInstance];
    return getIvarObject(backlight, "_brightnessSystemClient");
}

static id<SBBacklightControllerProtocol> backlightController(void) {
    Class<SBBacklightControllerProtocol> backlightCls = (Class<SBBacklightControllerProtocol>)objc_getClass("SBBacklightController");
    return [backlightCls sharedInstance];
}

static BOOL setBrightnessFactor(NSNumber *factor) {
    id<BrightnessSystemClientProtocol> bsc = brightnessClient();
    if (!bsc) {
        autoinstallLog(@"setBrightnessFactor: _brightnessSystemClient not found");
        return NO;
    }
    BOOL result = [bsc setProperty:factor forKey:@"DisplayBrightnessFactor"];
    autoinstallLog([NSString stringWithFormat:@"setBrightnessFactor: DisplayBrightnessFactor=%@ result=%d", factor, result]);
    return result;
}

static void applyDark(void) {
    @try {
        [backlightController() preventIdleSleep];
        setBrightnessFactor(@(0));
        autoinstallLog(@"applyDark: preventIdleSleep + DisplayBrightnessFactor=0");
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"applyDark: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
    }
}

static void removeDark(void) {
    @try {
        setBrightnessFactor(@(1));
        [backlightController() allowIdleSleep];
        autoinstallLog(@"removeDark: DisplayBrightnessFactor=1 + allowIdleSleep");
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"removeDark: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
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
    id<SBBacklightControllerProtocol> backlight = backlightController();
    id<BrightnessSystemClientProtocol> bsc = brightnessClient();
    id factor = bsc ? [bsc copyPropertyForKey:@"DisplayBrightnessFactor"] : nil;
    return @{
        @"ok": @YES,
        @"darkEnabled": @(isDarkFlagSet()),
        @"screenIsOn": @([backlight screenIsOn]),
        @"screenIsDim": @([backlight screenIsDim]),
        @"backlightState": @([backlight backlightState]),
        @"brightnessFactor": factor ? [factor description] : [NSNull null],
    };
}

static void handleSpringBoardRequest(NSDictionary *req) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"sb-bridge: handling action=%@ req=%@", action, req]);

    @try {
        if ([action isEqualToString:@"dark_on"]) {
            setDarkFlag(YES);
            applyDark();
            writeJSONFile(kSBResponsePath, screenStatusDict());
            return;
        }

        if ([action isEqualToString:@"dark_off"]) {
            setDarkFlag(NO);
            removeDark();
            writeJSONFile(kSBResponsePath, screenStatusDict());
            return;
        }

        if ([action isEqualToString:@"tap"]) {
            NSNumber *x = req[@"x"];
            NSNumber *y = req[@"y"];
            if (!x || !y) {
                writeJSONFile(kSBResponsePath, @{@"ok": @NO, @"error": @"missing x/y"});
                return;
            }
            dispatch_sync(dispatch_get_main_queue(), ^{
                autoinstallSynthesizeTap(CGPointMake([x doubleValue], [y doubleValue]));
            });
            autoinstallLog([NSString stringWithFormat:@"sb-bridge: tap synthesized at (%@, %@)", x, y]);
            writeJSONFile(kSBResponsePath, @{@"ok": @YES});
            return;
        }

        if ([action isEqualToString:@"probe_classes"]) {
            NSString *substring = req[@"substring"] ?: @"";
            int count = objc_getClassList(NULL, 0);
            Class *classes = (Class *)malloc(sizeof(Class) * count);
            count = objc_getClassList(classes, count);
            NSMutableArray *matches = [NSMutableArray array];
            for (int i = 0; i < count; i++) {
                NSString *name = NSStringFromClass(classes[i]);
                if ([name rangeOfString:substring options:NSCaseInsensitiveSearch].location != NSNotFound) {
                    [matches addObject:name];
                }
            }
            free(classes);
            [matches sortUsingSelector:@selector(compare:)];
            writeJSONFile(kSBResponsePath, @{@"ok": @YES, @"matches": matches});
            return;
        }

        if ([action isEqualToString:@"launch_app"]) {
            NSString *bundleId = req[@"bundleId"];
            if (!bundleId) {
                writeJSONFile(kSBResponsePath, @{@"ok": @NO, @"error": @"missing bundleId"});
                return;
            }
            if (isDarkFlagSet()) applyDark();
            int rc = sbsLaunchApplication(bundleId);
            autoinstallLog([NSString stringWithFormat:@"launch_app: SBSLaunchApplicationWithIdentifier(%@)=%d", bundleId, rc]);
            NSMutableDictionary *resp = [screenStatusDict() mutableCopy];
            resp[@"ok"] = rc == 0 ? @YES : @NO;
            resp[@"launchResult"] = @(rc);
            writeJSONFile(kSBResponsePath, resp);
            return;
        }

        if ([action isEqualToString:@"screen_status"] || [action isEqualToString:@"status"]) {
            writeJSONFile(kSBResponsePath, screenStatusDict());
            return;
        }

        writeJSONFile(kSBResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
    } @catch (NSException *exception) {
        autoinstallLog([NSString stringWithFormat:@"sb-bridge: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        writeJSONFile(kSBResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
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
        handleSpringBoardRequest(req);
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

%hook TFAppBuild

+ (id)buildFromDictionary:(NSDictionary *)dict {
    autoinstallLog([NSString stringWithFormat:@"+[TFAppBuild buildFromDictionary:] %@", dict]);
    return %orig;
}

%end

%hook TFAppCatalogManager

- (id)initWithNetworkManager:(id)networkManager nanoDeviceConnection:(id)nanoDeviceConnection {
    id result = %orig;
    gCatalogManager = result;
    autoinstallLog([NSString stringWithFormat:@"stashed TFAppCatalogManager (initWithNetworkManager:) %@", result]);
    return result;
}

- (id)initWithAppCatalog:(id)appCatalog networkManager:(id)networkManager nanoDeviceConnection:(id)nanoDeviceConnection {
    id result = %orig;
    gCatalogManager = result;
    autoinstallLog([NSString stringWithFormat:@"stashed TFAppCatalogManager (initWithAppCatalog:) %@", result]);
    return result;
}

- (id)getAllAppsWithRefresh:(BOOL)refresh completionBlock:(id)block {
    autoinstallLog([NSString stringWithFormat:@"-[TFAppCatalogManager getAllAppsWithRefresh:] refresh=%d", refresh]);
    return %orig;
}

%end

%hook TFAppInstaller

+ (id)installerWithInstallManager:(id)installManager nanoInstallManager:(id)nanoInstallManager {
    id result = %orig;
    gInstaller = result;
    autoinstallLog([NSString stringWithFormat:@"stashed TFAppInstaller (installerWithInstallManager:) %@", result]);
    return result;
}

- (id)initWithInstallManager:(id)installManager nanoInstallManager:(id)nanoInstallManager {
    id result = %orig;
    gInstaller = result;
    autoinstallLog([NSString stringWithFormat:@"stashed TFAppInstaller (initWithInstallManager:) %@", result]);
    return result;
}

- (id)requestInstall:(id)installable installationMode:(NSInteger)mode alertDelegate:(id)delegate withBackgroundTaskMaster:(id)master completionBlock:(id)block {
    autoinstallLog([NSString stringWithFormat:@"-[TFAppInstaller requestInstall:] mode=%ld installable=%@", (long)mode, installable]);
    return %orig;
}

%end

%hook TFInstallableBundle

- (id)initWithApp:(id)app build:(id)build buildGroup:(id)buildGroup preinstalledState:(NSInteger)a parentInstalledState:(NSInteger)b canAutoUpdate:(BOOL)c allowReinstallSameVersion:(BOOL)d variant:(id)variant {
    id result = %orig;
    autoinstallLog([NSString stringWithFormat:@"-[TFInstallableBundle initWithApp:build:buildGroup:...variant:] app=%@ build=%@ buildGroup=%@ variant=%@ -> %@",
        app, build, buildGroup, variant, result]);
    return result;
}

%end

%hook TFNetworkManagerResponse

- (id)initWithURLResponse:(NSURLResponse *)response data:(NSData *)data error:(NSError *)error {
    NSString *body = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    if (body.length > 6000) body = [body substringToIndex:6000];
    autoinstallLog([NSString stringWithFormat:@"-[TFNetworkManagerResponse initWithURLResponse:data:error:] url=%@ error=%@\nbody=%@",
        response.URL, error, body]);
    return %orig;
}

%end

static NSString * const kRequestPath = @"/tmp/autoinstall-request.json";
static NSString * const kResponsePath = @"/tmp/autoinstall-response.json";
static NSString * const kInstallStatusPath = @"/tmp/autoinstall-install-status.json";

static void fetchJSON(NSString *urlString, void (^completion)(id json, NSString *error)) {
    NSURL *url = [NSURL URLWithString:urlString];
    Class<TFNetworkManagerProtocol> cls = (Class<TFNetworkManagerProtocol>)objc_getClass("TFNetworkManager");
    id<TFNetworkManagerProtocol> manager = [cls shared];
    autoinstallLog([NSString stringWithFormat:@"fetchJSON: cls=%@ manager=%@ url=%@", cls, manager, url]);

    id enqueued = [manager enqueueDataTaskWithURL:url completionHandler:^(id response) {
        autoinstallLog([NSString stringWithFormat:@"fetchJSON: completion fired, response=%@", response]);
        @try {
            id<TFNetworkManagerResponseProtocol> typedResponse = response;
            NSError *error = [typedResponse error];
            id data = [typedResponse data];
            autoinstallLog([NSString stringWithFormat:@"fetchJSON: error=%@ data=%@", error, data]);
            if (error) {
                completion(nil, error.localizedDescription);
                return;
            }
            if (!data) {
                completion(nil, @"no data in response");
                return;
            }
            completion(data, nil);
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"fetchJSON: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            completion(nil, [NSString stringWithFormat:@"exception: %@", exception.reason]);
        }
    }];
    autoinstallLog([NSString stringWithFormat:@"fetchJSON: enqueued=%@", enqueued]);
}

static NSString *describeClass(NSString *className) {
    Class cls = objc_getClass([className UTF8String]);
    if (!cls) return [NSString stringWithFormat:@"%@: NOT FOUND", className];

    NSMutableString *out = [NSMutableString stringWithFormat:@"== %@ ==\nClass methods:\n", className];
    unsigned int count = 0;
    Method *classMethods = class_copyMethodList(object_getClass(cls), &count);
    for (unsigned int i = 0; i < count; i++) {
        SEL sel = method_getName(classMethods[i]);
        [out appendFormat:@"  + %@\n", NSStringFromSelector(sel)];
    }
    free(classMethods);

    [out appendString:@"Instance methods:\n"];
    Method *instMethods = class_copyMethodList(cls, &count);
    for (unsigned int i = 0; i < count; i++) {
        SEL sel = method_getName(instMethods[i]);
        [out appendFormat:@"  - %@\n", NSStringFromSelector(sel)];
    }
    free(instMethods);

    return out;
}

static void handleRequest(NSDictionary *req) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"probe"]) {
        NSString *className = req[@"class"];
        NSString *desc = describeClass(className);
        autoinstallLog(desc);
        writeJSONFile(kResponsePath, @{@"ok": @YES, @"description": desc});
        return;
    }

    if ([action isEqualToString:@"probe_live"]) {
        NSString *target = req[@"target"];
        id obj = [target isEqualToString:@"catalogManager"] ? gCatalogManager : gInstaller;
        if (!obj) {
            writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"target not stashed"});
            return;
        }
        NSString *desc = describeClass(NSStringFromClass([obj class]));
        autoinstallLog(desc);
        writeJSONFile(kResponsePath, @{@"ok": @YES, @"description": desc, @"class": NSStringFromClass([obj class])});
        return;
    }

    if ([action isEqualToString:@"install"]) {
        @try {
            beginBackgroundKeepAlive();

            if (!gCatalogManager) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"gCatalogManager not stashed yet"});
                return;
            }
            if (!gInstaller) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"gInstaller not stashed yet"});
                return;
            }

            NSNumber *appId = req[@"appId"];
            NSDictionary *buildDict = req[@"build"];
            if (!appId || !buildDict) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"missing appId or build"});
                return;
            }

            id<TFAppCatalogManagerProtocol> catalogManager = gCatalogManager;
            id app = [catalogManager getAppCatalogCachedAppForAppID:appId];
            if (!app) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"getAppCatalogCachedAppForAppID: returned nil - is the catalog populated?"});
                return;
            }

            Class<TFAppBuildProtocol> buildCls = (Class<TFAppBuildProtocol>)objc_getClass("TFAppBuild");
            id build = [buildCls buildFromDictionary:buildDict];
            if (!build) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"buildFromDictionary: returned nil"});
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
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"initWithApp:build:... returned nil"});
                return;
            }

            autoinstallLog([NSString stringWithFormat:@"install: app=%@ build=%@ installable=%@", app, build, installable]);

            void (^completion)(void) = ^{
                autoinstallLog(@"install: completionBlock fired");
                writeJSONFile(kInstallStatusPath, @{@"ok": @YES});
            };

            id<TFAppInstallerProtocol> installer = gInstaller;
            id result = [installer requestInstall:installable installationMode:0 alertDelegate:nil withBackgroundTaskMaster:nil completionBlock:completion];
            autoinstallLog([NSString stringWithFormat:@"install: requestInstall: returned %@", result]);
            writeJSONFile(kResponsePath, @{@"ok": @YES, @"requested": @YES});
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
        }
        return;
    }

    if ([action isEqualToString:@"list_trains"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains", appId];
        fetchJSON(url, ^(id json, NSString *error) {
            if (error) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": error});
            } else {
                writeJSONFile(kResponsePath, @{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"list_builds"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *train = req[@"trainVersion"];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains/%@/builds", appId, train];
        fetchJSON(url, ^(id json, NSString *error) {
            if (error) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": error});
            } else {
                writeJSONFile(kResponsePath, @{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"status"]) {
        writeJSONFile(kResponsePath, @{
            @"ok": @YES,
            @"hasInstaller": gInstaller ? @YES : @NO,
            @"hasCatalogManager": gCatalogManager ? @YES : @NO,
            @"backgroundTaskActive": gBackgroundTaskId != UIBackgroundTaskInvalid ? @YES : @NO,
            @"backgroundTimeRemaining": @([[UIApplication sharedApplication] backgroundTimeRemaining]),
        });
        return;
    }

    if ([action isEqualToString:@"end_background_keepalive"]) {
        endBackgroundKeepAlive();
        writeJSONFile(kResponsePath, @{@"ok": @YES});
        return;
    }

    writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
}

static dispatch_queue_t gBridgeQueue = nil;
static dispatch_source_t gBridgeTimer = nil;

static void startTestFlightSide(void) {
    gBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.bridge", DISPATCH_QUEUE_SERIAL);
    gBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gBridgeQueue);
    dispatch_source_set_timer(gBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gBridgeTimer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
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
        handleRequest(req);
    });
    dispatch_resume(gBridgeTimer);
    autoinstallLog(@"bridge: request-file watcher started");
}

#pragma mark - App Store side: NSXPCConnection service-name logging (find who renders the purchase sheet)

// Also used by the UIAlertController hook further down - only act in the App Store process, never
// TestFlight/SpringBoard, or we'd log/auto-tap unrelated things there.
static BOOL gIsAppStoreProcess = NO;
// AMSPaymentSheetTask etc. live in appstored itself, a separate process from com.apple.AppStore.
static BOOL gIsAppStoredProcess = NO;
static BOOL gIsStoreKitDProcess = NO;

%hook NSXPCConnection

- (id)initWithServiceName:(NSString *)serviceName {
    if (gIsAppStoreProcess) {
        autoinstallLog([NSString stringWithFormat:@"xpc: initWithServiceName: %@", serviceName]);
    }
    return %orig;
}

- (id)initWithMachServiceName:(NSString *)machServiceName options:(NSXPCConnectionOptions)options {
    if (gIsAppStoreProcess) {
        autoinstallLog([NSString stringWithFormat:@"xpc: initWithMachServiceName: %@ options=%lu", machServiceName, (unsigned long)options]);
    }
    return %orig;
}

- (void)resume {
    if (gIsAppStoreProcess) {
        autoinstallLog([NSString stringWithFormat:@"xpc: resume on connection %@ serviceName=%@", self, [self valueForKey:@"serviceName"]]);
    }
    %orig;
}

- (void)setRemoteObjectInterface:(NSXPCInterface *)interface {
    if (gIsAppStoreProcess && interface) {
        autoinstallLog([NSString stringWithFormat:@"xpc: setRemoteObjectInterface: connection=%@ serviceName=%@ %@",
            self, [self valueForKey:@"serviceName"], autoinstallDescribeXPCInterface(interface)]);
    }
    %orig;
}

// The incoming/callback side - if submitRequest:delegate:withReplyHandler:'s delegate object is
// wired up the standard NSXPCConnection way (exportedObject/exportedInterface, so the remote side
// can call back into it), this captures both the exact class AND the exact protocol/method list
// safely via normal Objective-C parameter passing - no raw pointer guessing needed.
- (void)setExportedInterface:(NSXPCInterface *)interface {
    if (gIsAppStoreProcess && interface) {
        autoinstallLog([NSString stringWithFormat:@"xpc: setExportedInterface: connection=%@ serviceName=%@ %@",
            self, [self valueForKey:@"serviceName"], autoinstallDescribeXPCInterface(interface)]);
    }
    %orig;
}

- (void)setExportedObject:(id)object {
    if (gIsAppStoreProcess && object) {
        autoinstallLog([NSString stringWithFormat:@"xpc: setExportedObject: connection=%@ serviceName=%@ object=%@ class=%@",
            self, [self valueForKey:@"serviceName"], object, [object class]]);
    }
    %orig;
}

- (void)_sendInvocation:(NSInvocation *)invocation orArguments:(void **)args count:(NSUInteger)count
        methodSignature:(NSMethodSignature *)sig selector:(SEL)sel withProxy:(id)proxy {
    if (gIsAppStoreProcess) {
        NSString *selName = NSStringFromSelector(sel);
        autoinstallLog([NSString stringWithFormat:@"xpc-send-any: sel=%@", selName]);
        if ([selName rangeOfString:@"purchaseWithRequest" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [selName rangeOfString:@"uiHostProxy" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [selName rangeOfString:@"submitRequest" options:NSCaseInsensitiveSearch].location != NSNotFound) {
            @try {
                autoinstallLog([NSString stringWithFormat:@"xpc-send: sel=%@ invocation=%@ sig=%@ proxy=%@ serviceName=%@",
                    selName, invocation, sig, proxy, [self valueForKey:@"serviceName"]]);
                if (invocation && sig) {
                    NSUInteger numArgs = [sig numberOfArguments];
                    for (NSUInteger i = 2; i < numArgs; i++) {
                        const char *argType = [sig getArgumentTypeAtIndex:i];
                        if (argType && argType[0] == '@') {
                            __unsafe_unretained id argObj = nil;
                            [invocation getArgument:&argObj atIndex:i];
                            autoinstallLog([NSString stringWithFormat:@"  arg[%lu] = %@ class=%@",
                                (unsigned long)i, argObj, [argObj class]]);
                        } else {
                            autoinstallLog([NSString stringWithFormat:@"  arg[%lu] type=%s (non-object, skipped)",
                                (unsigned long)i, argType ?: "?"]);
                        }
                    }
                }
            } @catch (NSException *e) {
                autoinstallLog([NSString stringWithFormat:@"xpc-send: EXCEPTION inspecting args: %@ %@", e.name, e.reason]);
            }
        }
    }
    %orig;
}

%end

// Per-parameter XPC proxy configuration - this is how a method like submitRequest:delegate:
// withReplyHandler: declares that a specific ARGUMENT (not the whole connection) is itself an
// XPC-proxied object conforming to some protocol, when that argument isn't wired up via the
// simpler connection-level exportedInterface/exportedObject. Safe, standard parameter types only.
%hook NSXPCInterface

- (void)setInterface:(NSXPCInterface *)interface forSelector:(SEL)sel argumentIndex:(NSUInteger)arg ofReply:(BOOL)ofReply {
    if (gIsAppStoreProcess) {
        NSString *selName = NSStringFromSelector(sel);
        if ([selName rangeOfString:@"submitRequest"].location != NSNotFound ||
            [selName rangeOfString:@"purchaseWithRequest"].location != NSNotFound) {
            autoinstallLog([NSString stringWithFormat:@"xpc-iface: setInterface:forSelector:%@ argumentIndex:%lu ofReply:%d -> %@",
                selName, (unsigned long)arg, ofReply, autoinstallDescribeXPCInterface(interface)]);
        }
    }
    %orig;
}

%end

#pragma mark - App Store side: SKUIItemStateCenter probe + purchase-pipeline install

%hook ASDRequestBroker

- (id)submitRequest:(id)request withReplyHandler:(void (^)(id response))handler {
    if (gIsAppStoreProcess) {
        @try {
            autoinstallLog([NSString stringWithFormat:@"ASDRequestBroker submitRequest: request=%@ class=%@", request, [request class]]);
            NSString *fullDesc = [request respondsToSelector:@selector(debugDescription)] ? [request debugDescription] : [request description];
            autoinstallLog([NSString stringWithFormat:@"ASDRequestBroker request full description:\n%@", fullDesc]);
        } @catch (NSException *e) {
            autoinstallLog([NSString stringWithFormat:@"ASDRequestBroker submitRequest: EXCEPTION describing request: %@ %@", e.name, e.reason]);
        }
    }
    id result = %orig;
    if (gIsAppStoreProcess) {
        autoinstallLog([NSString stringWithFormat:@"ASDRequestBroker submitRequest: returned %@", result]);
    }
    return result;
}

%end

// Lives in appstored, not the App Store app. This is the real orchestrator behind the purchase
// confirmation sheet - _presentPaymentConfirmationWithPaymentRequest:purchaseResult: is the actual
// presentation call. Experiment: suppress it entirely (don't call %orig) and see whether the
// surrounding task/state-machine just proceeds anyway. Worst case matches the existing "nobody
// tapped" hang we already see, so this is safe to try.
%hook AMSPaymentSheetTask

- (id)_presentPaymentConfirmationWithPaymentRequest:(id)paymentRequest purchaseResult:(id)purchaseResult {
    if (gIsAppStoredProcess) {
        @try {
            autoinstallLog(@"AMSPaymentSheetTask _presentPaymentConfirmation: called");
            NSString *reqDesc = [NSString stringWithFormat:@"paymentRequest class=%@", [paymentRequest class]];
            autoinstallLog(reqDesc);
            NSString *resDesc = [NSString stringWithFormat:@"purchaseResult class=%@", [purchaseResult class]];
            autoinstallLog(resDesc);
            id taskState = [(id)self valueForKey:@"state"];
            NSString *stateDesc = [NSString stringWithFormat:@"self.state=%@", taskState];
            autoinstallLog(stateDesc);
        } @catch (NSException *e) {
            autoinstallLog([NSString stringWithFormat:@"AMSPaymentSheetTask _presentPaymentConfirmation: EXCEPTION describing args: %@ %@", e.name, e.reason]);
        }
        autoinstallLog(@"AMSPaymentSheetTask _presentPaymentConfirmation: SUPPRESSING %orig, not presenting UI");
        return nil;
    }
    return %orig;
}

%end

// LNConfirmationRequest looks like a *generic* system confirmation-request object (not payment/
// PassKit-specific like AMSPaymentSheetTask above, which never fired for this free-app install) -
// respondWithConfirmation: is exactly the auto-confirm hook this whole session has been looking
// for. Hook the designated initializer, stash the live instance, and immediately respond YES.
%hook LNConfirmationRequest

- (id)initWithIdentifier:(id)identifier parameterName:(id)parameterName value:(id)value dialog:(id)dialog viewSnippet:(id)viewSnippet {
    id result = %orig;
    if ((gIsAppStoredProcess || gIsStoreKitDProcess || isSpringBoard()) && result) {
        @try {
            autoinstallLog([NSString stringWithFormat:@"LNConfirmationRequest created: identifier=%@ parameterName=%@ value=%@ dialog=%@",
                identifier, parameterName, value, dialog]);
            dispatch_async(dispatch_get_main_queue(), ^{
                @try {
                    [(id<LNConfirmationRequestProtocol>)result respondWithConfirmation:YES];
                    autoinstallLog(@"LNConfirmationRequest: respondWithConfirmation:YES sent");
                } @catch (NSException *e) {
                    autoinstallLog([NSString stringWithFormat:@"LNConfirmationRequest: EXCEPTION calling respondWithConfirmation:: %@ %@", e.name, e.reason]);
                }
            });
        } @catch (NSException *e) {
            autoinstallLog([NSString stringWithFormat:@"LNConfirmationRequest: EXCEPTION describing new instance: %@ %@", e.name, e.reason]);
        }
    }
    return result;
}

%end

// Two guesses (AMSPaymentSheetTask, LNConfirmationRequest) both failed to fire - stop guessing
// class names and get a real call stack instead. SFShowPurchaseRequestSheetCommand is CONFIRMED
// (via probe_classes) to be the right data class; hook its actual designated initializer and log
// exactly who constructs it, in whichever process it happens.
%hook SFShowPurchaseRequestSheetCommand

- (id)initWithProtobuf:(id)protobuf {
    id result = %orig;
    if ((gIsAppStoreProcess || gIsAppStoredProcess || gIsStoreKitDProcess || isSpringBoard()) && result) {
        NSArray *stack = [NSThread callStackSymbols];
        autoinstallLog([NSString stringWithFormat:@"SFShowPurchaseRequestSheetCommand initWithProtobuf: called (appStore=%d appstored=%d). Call stack:\n%@",
            gIsAppStoreProcess, gIsAppStoredProcess, [stack componentsJoinedByString:@"\n"]]);
    }
    return result;
}

- (id)initWithCoder:(NSCoder *)coder {
    id result = %orig;
    if ((gIsAppStoreProcess || gIsAppStoredProcess || gIsStoreKitDProcess || isSpringBoard()) && result) {
        NSArray *stack = [NSThread callStackSymbols];
        autoinstallLog([NSString stringWithFormat:@"SFShowPurchaseRequestSheetCommand initWithCoder: called (appStore=%d appstored=%d). Call stack:\n%@",
            gIsAppStoreProcess, gIsAppStoredProcess, [stack componentsJoinedByString:@"\n"]]);
    }
    return result;
}

%end

// Same call-stack technique on SSPaymentSheet (the data model, confirmed loaded in both processes)
// in case the command class itself isn't what's directly constructed in this flow.
%hook SSPaymentSheet

- (id)initWithServerResponse:(id)serverResponse {
    id result = %orig;
    if ((gIsAppStoreProcess || gIsAppStoredProcess || gIsStoreKitDProcess || isSpringBoard()) && result) {
        NSArray *stack = [NSThread callStackSymbols];
        autoinstallLog([NSString stringWithFormat:@"SSPaymentSheet initWithServerResponse: called (appStore=%d appstored=%d). Call stack:\n%@",
            gIsAppStoreProcess, gIsAppStoredProcess, [stack componentsJoinedByString:@"\n"]]);
    }
    return result;
}

- (id)initWithServerResponse:(id)serverResponse buyParams:(id)buyParams {
    id result = %orig;
    if ((gIsAppStoreProcess || gIsAppStoredProcess || gIsStoreKitDProcess || isSpringBoard()) && result) {
        NSArray *stack = [NSThread callStackSymbols];
        autoinstallLog([NSString stringWithFormat:@"SSPaymentSheet initWithServerResponse:buyParams: called (appStore=%d appstored=%d). Call stack:\n%@",
            gIsAppStoreProcess, gIsAppStoredProcess, [stack componentsJoinedByString:@"\n"]]);
    }
    return result;
}

%end

%hook UIAlertController

- (void)addAction:(UIAlertAction *)action {
    %orig;
    if (!gIsAppStoreProcess) return;
    NSString *title = [action.title lowercaseString] ?: @"";
    NSArray *affirmativeWords = @[@"install", @"confirm", @"buy", @"get"];
    for (NSString *word in affirmativeWords) {
        if ([title containsString:word]) {
            objc_setAssociatedObject(self, "autoinstallConfirmAction", action, OBJC_ASSOCIATION_RETAIN);
            autoinstallLog([NSString stringWithFormat:@"alert: marked action '%@' as auto-confirm target", action.title]);
            return;
        }
    }
}

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (!gIsAppStoreProcess) return;
    UIAlertAction *action = objc_getAssociatedObject(self, "autoinstallConfirmAction");
    if (!action) return;
    autoinstallLog([NSString stringWithFormat:@"alert: auto-confirming action '%@' in 0.4s", action.title]);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.4 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        @try {
            void (^handler)(UIAlertAction *) = [action valueForKey:@"handler"];
            if (handler) {
                handler(action);
                autoinstallLog(@"alert: handler invoked directly");
            } else {
                autoinstallLog(@"alert: no handler found via valueForKey:");
            }
        } @catch (NSException *e) {
            autoinstallLog([NSString stringWithFormat:@"alert: EXCEPTION invoking handler: %@ %@", e.name, e.reason]);
        }
    });
}

%end

// +[SKUIClientContext defaultContext] returns nil in the real App Store app (unlike in MuffinStore's
// own standalone app, which presumably registers itself as the default during its own app lifecycle),
// and a bare alloc/init context is empty enough that _performPurchases: silently no-ops on it instead
// of throwing. Stash whatever live instance the App Store app's own code actually constructs instead -
// same pattern as TFAppInstaller/TFAppCatalogManager below.
static id gAppStoreClientContext = nil;

%hook SKUIClientContext

- (id)initWithConfigurationDictionary:(NSDictionary *)dict {
    id result = %orig;
    gAppStoreClientContext = result;
    autoinstallLog([NSString stringWithFormat:@"stashed SKUIClientContext (initWithConfigurationDictionary:) %@", result]);
    return result;
}

- (void)_setApplicationController:(id)controller {
    %orig;
    gAppStoreClientContext = self;
    autoinstallLog([NSString stringWithFormat:@"stashed SKUIClientContext (_setApplicationController:) self=%@ controller=%@", self, controller]);
}

%end

static NSString * const kASRequestPath = @"/tmp/autoinstall-as-request.json";
static NSString * const kASResponsePath = @"/tmp/autoinstall-as-response.json";
static NSString * const kASInstallStatusPath = @"/tmp/autoinstall-as-install-status.json";

static NSString *describeSelectorPresence(NSString *className, NSArray<NSString *> *classSelectors, NSArray<NSString *> *instanceSelectors) {
    Class cls = objc_getClass([className UTF8String]);
    if (!cls) return [NSString stringWithFormat:@"%@: class NOT FOUND", className];

    NSMutableString *out = [NSMutableString stringWithFormat:@"%@: class found\n", className];
    for (NSString *sel in classSelectors) {
        BOOL has = [object_getClass(cls) instancesRespondToSelector:NSSelectorFromString(sel)];
        [out appendFormat:@"  +%@ -> %@\n", sel, has ? @"present" : @"MISSING"];
    }
    for (NSString *sel in instanceSelectors) {
        BOOL has = [cls instancesRespondToSelector:NSSelectorFromString(sel)];
        [out appendFormat:@"  -%@ -> %@\n", sel, has ? @"present" : @"MISSING"];
    }
    return out;
}

static void handleAppStoreRequest(NSDictionary *req) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"as-bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"status"]) {
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"hasStashedClientContext": gAppStoreClientContext ? @YES : @NO});
        return;
    }

    if ([action isEqualToString:@"probe_classes"]) {
        NSString *substring = req[@"substring"] ?: @"ClientContext";
        int count = objc_getClassList(NULL, 0);
        Class *classes = (Class *)malloc(sizeof(Class) * count);
        count = objc_getClassList(classes, count);
        NSMutableArray *matches = [NSMutableArray array];
        for (int i = 0; i < count; i++) {
            NSString *name = NSStringFromClass(classes[i]);
            if ([name rangeOfString:substring options:NSCaseInsensitiveSearch].location != NSNotFound) {
                [matches addObject:name];
            }
        }
        free(classes);
        [matches sortUsingSelector:@selector(compare:)];
        autoinstallLog([NSString stringWithFormat:@"probe_classes(%@): %@", substring, matches]);
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"matches": matches});
        return;
    }

    if ([action isEqualToString:@"tap"]) {
        NSNumber *x = req[@"x"];
        NSNumber *y = req[@"y"];
        if (!x || !y) {
            writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": @"missing x/y"});
            return;
        }
        dispatch_sync(dispatch_get_main_queue(), ^{
            autoinstallSynthesizeTap(CGPointMake([x doubleValue], [y doubleValue]));
        });
        autoinstallLog([NSString stringWithFormat:@"tap: synthesized at (%@, %@)", x, y]);
        writeJSONFile(kASResponsePath, @{@"ok": @YES});
        return;
    }

    if ([action isEqualToString:@"find_view"]) {
        NSString *substring = req[@"class"] ?: @"";
        __block NSMutableArray *matches = [NSMutableArray array];
        dispatch_sync(dispatch_get_main_queue(), ^{
            NSArray *windows = [[UIApplication sharedApplication] valueForKey:@"windows"];
            void (^__block __weak weakWalk)(UIView *);
            void (^walk)(UIView *);
            weakWalk = walk = ^(UIView *view) {
                NSString *className = NSStringFromClass([view class]);
                if ([className rangeOfString:substring options:NSCaseInsensitiveSearch].location != NSNotFound) {
                    CGRect absFrame = [view convertRect:view.bounds toView:nil];
                    [matches addObject:@{
                        @"class": className,
                        @"x": @(CGRectGetMidX(absFrame)),
                        @"y": @(CGRectGetMidY(absFrame)),
                        @"width": @(absFrame.size.width),
                        @"height": @(absFrame.size.height),
                    }];
                }
                for (UIView *sub in view.subviews) weakWalk(sub);
            };
            for (UIWindow *w in windows) walk(w);
        });
        autoinstallLog([NSString stringWithFormat:@"find_view(%@): %@", substring, matches]);
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"matches": matches});
        return;
    }

    if ([action isEqualToString:@"dump_scenes"]) {
        __block NSString *dump = @"";
        dispatch_sync(dispatch_get_main_queue(), ^{
            NSMutableString *out = [NSMutableString string];
            NSSet *scenes = [[UIApplication sharedApplication] connectedScenes];
            [out appendFormat:@"connectedScenes count=%lu\n", (unsigned long)scenes.count];
            for (id scene in scenes) {
                [out appendFormat:@"=== scene %@ class=%@ activationState=%@ ===\n", scene, [scene class],
                    [scene respondsToSelector:@selector(activationState)] ? @([(id)scene activationState]) : @"?"];
                @try {
                    NSArray *windows = [scene valueForKey:@"windows"];
                    for (UIWindow *w in windows) {
                        [out appendFormat:@"  window %@ level=%f hidden=%d rootVC=%@\n", w, w.windowLevel, w.hidden, w.rootViewController];
                        UIViewController *vc = w.rootViewController;
                        while (vc.presentedViewController) {
                            vc = vc.presentedViewController;
                            [out appendFormat:@"    presented: %@\n", [vc class]];
                        }
                    }
                } @catch (NSException *e) {
                    [out appendFormat:@"  EXCEPTION reading scene windows: %@\n", e.reason];
                }
            }
            dump = out;
        });
        autoinstallLog([NSString stringWithFormat:@"dump_scenes:\n%@", dump]);
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"description": dump});
        return;
    }

    if ([action isEqualToString:@"dump_windows"]) {
        __block NSString *dump = @"";
        dispatch_sync(dispatch_get_main_queue(), ^{
            NSMutableString *out = [NSMutableString string];
            NSArray *windows = [[UIApplication sharedApplication] valueForKey:@"windows"];
            for (UIWindow *w in windows) {
                [out appendFormat:@"=== window %@ (level=%f) ===\n", w, w.windowLevel];
                @try {
                    NSString *desc = [w performSelector:@selector(recursiveDescription)];
                    [out appendString:desc ?: @"(nil)"];
                } @catch (NSException *e) {
                    [out appendFormat:@"EXCEPTION: %@", e.reason];
                }
                [out appendString:@"\n\n"];
            }
            dump = out;
        });
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"description": dump});
        return;
    }

    if ([action isEqualToString:@"probe"]) {
        NSString *className = req[@"class"];
        NSString *desc = describeClass(className);
        autoinstallLog(desc);
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"description": desc});
        return;
    }

    if ([action isEqualToString:@"probe_client_context"]) {
        NSString *desc = describeClass(@"SKUIClientContext");
        autoinstallLog(desc);
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"description": desc});
        return;
    }

    if ([action isEqualToString:@"probe_skui"]) {
        NSMutableString *out = [NSMutableString string];
        [out appendString:describeSelectorPresence(@"SKUIItemStateCenter", @[@"defaultCenter"], @[@"_newPurchasesWithItems:", @"_performPurchases:hasBundlePurchase:withClientContext:completionBlock:", @"_performSoftwarePurchases:withClientContext:completionBlock:"])];
        [out appendString:describeSelectorPresence(@"SKUIItem", @[], @[@"initWithLookupDictionary:", @"setValue:forKey:"])];
        [out appendString:describeSelectorPresence(@"SKUIItemOffer", @[], @[@"initWithLookupDictionary:"])];
        [out appendString:describeSelectorPresence(@"SKUIClientContext", @[@"defaultContext"], @[])];
        autoinstallLog(out);
        writeJSONFile(kASResponsePath, @{@"ok": @YES, @"description": out});
        return;
    }

    if ([action isEqualToString:@"install"]) {
        NSNumber *adamId = req[@"adamId"];
        NSNumber *versionId = req[@"versionId"];
        if (!adamId) {
            writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": @"missing adamId"});
            return;
        }

        // StoreKitUI's singletons appear to require the main thread - defaultCenter/defaultContext
        // returned nil when called from our background bridge queue, worked once dispatched here.
        dispatch_sync(dispatch_get_main_queue(), ^{
            @try {
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
                    writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": @"initWithLookupDictionary: returned nil"});
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

                NSString *contextMode = req[@"contextMode"] ?: @"fallback";
                id<SKUIClientContextProtocol> clientContext = nil;
                if ([contextMode isEqualToString:@"stashed"]) {
                    clientContext = gAppStoreClientContext;
                } else if ([contextMode isEqualToString:@"default"]) {
                    clientContext = [contextCls defaultContext];
                }
                if (!clientContext) {
                    id fallbackConfig = [contextCls _fallbackConfigurationDictionary];
                    clientContext = [[contextCls alloc] initWithConfigurationDictionary:fallbackConfig];
                    autoinstallLog([NSString stringWithFormat:@"as-install: contextMode=%@ built fresh fallback, fallbackConfig=%@, built: %@", contextMode, fallbackConfig, clientContext]);
                }
                autoinstallLog([NSString stringWithFormat:@"as-install: centerCls=%@ center=%@ contextCls=%@ clientContext=%@ (stashed=%@)", centerCls, center, contextCls, clientContext, gAppStoreClientContext ? @"YES" : @"NO"]);
                if (!center || !clientContext) {
                    writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"defaultCenter=%@ defaultContext=%@ (nil check on main thread)", center, clientContext]});
                    return;
                }

                id purchases = [center _newPurchasesWithItems:@[(id)item]];
                autoinstallLog([NSString stringWithFormat:@"as-install: adamId=%@ versionId=%@ offerString=%@ purchases=%@", adamIdStr, versionId, offerString, purchases]);

                void (^completion)(id) = ^(id arg1) {
                    autoinstallLog([NSString stringWithFormat:@"as-install: completionBlock fired arg1=%@ class=%@", arg1, [arg1 class]]);
                    writeJSONFile(kASInstallStatusPath, @{@"ok": @YES});
                };

                if ([req[@"method"] isEqualToString:@"software"]) {
                    [center _performSoftwarePurchases:purchases withClientContext:(id)clientContext completionBlock:completion];
                } else {
                    [center _performPurchases:purchases hasBundlePurchase:NO withClientContext:(id)clientContext completionBlock:completion];
                }
                writeJSONFile(kASResponsePath, @{@"ok": @YES, @"requested": @YES});
            } @catch (NSException *exception) {
                autoinstallLog([NSString stringWithFormat:@"as-install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
                writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
            }
        });
        return;
    }

    writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
}

static dispatch_queue_t gASBridgeQueue = nil;
static dispatch_source_t gASBridgeTimer = nil;

static void startAppStoreSide(void) {
    gASBridgeQueue = dispatch_queue_create("dev.adrian.autoinstall.as-bridge", DISPATCH_QUEUE_SERIAL);
    gASBridgeTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gASBridgeQueue);
    dispatch_source_set_timer(gASBridgeTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(gASBridgeTimer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
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
        handleAppStoreRequest(req);
    });
    dispatch_resume(gASBridgeTimer);
    autoinstallLog(@"as-bridge: request-file watcher started (probe-only)");
}

#pragma mark - Generic probe-only bridge, reusable for any daemon we inject into (amsengagementd,
#pragma mark   appstored, ...) - just class/method introspection, no state, safe by construction.

static void handleGenericProbeRequest(NSDictionary *req, NSString *responsePath, NSString *logPrefix) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"%@: handling action=%@ req=%@", logPrefix, action, req]);

    if ([action isEqualToString:@"status"]) {
        writeJSONFile(responsePath, @{@"ok": @YES, @"running": @YES});
        return;
    }

    if ([action isEqualToString:@"probe_classes"]) {
        NSString *substring = req[@"substring"] ?: @"";
        int count = objc_getClassList(NULL, 0);
        Class *classes = (Class *)malloc(sizeof(Class) * count);
        count = objc_getClassList(classes, count);
        NSMutableArray *matches = [NSMutableArray array];
        for (int i = 0; i < count; i++) {
            NSString *name = NSStringFromClass(classes[i]);
            if ([name rangeOfString:substring options:NSCaseInsensitiveSearch].location != NSNotFound) {
                [matches addObject:name];
            }
        }
        free(classes);
        [matches sortUsingSelector:@selector(compare:)];
        writeJSONFile(responsePath, @{@"ok": @YES, @"matches": matches});
        return;
    }

    if ([action isEqualToString:@"probe"]) {
        NSString *className = req[@"class"];
        NSString *desc = describeClass(className);
        autoinstallLog(desc);
        writeJSONFile(responsePath, @{@"ok": @YES, @"description": desc});
        return;
    }

    writeJSONFile(responsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
}

static void startGenericProbeSide(NSString *requestPath, NSString *responsePath, NSString *logPrefix) {
    dispatch_queue_t queue = dispatch_queue_create([[NSString stringWithFormat:@"dev.adrian.autoinstall.%@-bridge", logPrefix] UTF8String], DISPATCH_QUEUE_SERIAL);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(timer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
        if (![fm fileExistsAtPath:requestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:requestPath];
        [fm removeItemAtPath:requestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) return;
        handleGenericProbeRequest(req, responsePath, logPrefix);
    });
    dispatch_resume(timer);
    static NSMutableArray *keepAliveTimers = nil;
    if (!keepAliveTimers) keepAliveTimers = [NSMutableArray array];
    [keepAliveTimers addObject:timer];
    autoinstallLog([NSString stringWithFormat:@"%@-bridge: request-file watcher started", logPrefix]);
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
    } else if ([processName isEqualToString:@"amsengagementd"]) {
        startGenericProbeSide(@"/tmp/autoinstall-ams-request.json", @"/tmp/autoinstall-ams-response.json", @"ams");
    } else if ([processName isEqualToString:@"appstored"]) {
        gIsAppStoredProcess = YES;
        startGenericProbeSide(@"/tmp/autoinstall-appstored-request.json", @"/tmp/autoinstall-appstored-response.json", @"appstored");
    } else if ([processName isEqualToString:@"storekitd"]) {
        gIsStoreKitDProcess = YES;
        startGenericProbeSide(@"/tmp/autoinstall-skd-request.json", @"/tmp/autoinstall-skd-response.json", @"skd");
    } else {
        startTestFlightSide();
    }
}
