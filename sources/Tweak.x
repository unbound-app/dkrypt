#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
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
- (id)requestInstall:(id)installable installationMode:(NSInteger)mode alertDelegate:(id)delegate withBackgroundTaskMaster:(id)master completionBlock:(id)block;
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

static void writeJSONFile(NSString *path, id obj) {
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingPrettyPrinted error:&err];
    if (!data) {
        data = [[NSString stringWithFormat:@"{\"ok\":false,\"error\":\"serialize failed: %@\"}", err] dataUsingEncoding:NSUTF8StringEncoding];
    }
    [data writeToFile:path atomically:YES];
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
        @"bridgeVersion": @"1.1.0",
        @"capabilities": @[@"list_trains", @"list_builds", @"install", @"status", @"diagnostics", @"idempotent_install"],
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

static void handleRequest(NSDictionary *req) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"bridge: handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"install"]) {
        @try {
            beginBackgroundKeepAlive();
            NSString *operationId = [req[@"operationId"] isKindOfClass:[NSString class]] ? req[@"operationId"] : [[NSUUID UUID] UUIDString];
            NSDictionary *previousStatus = readJSONFile(kInstallStatusPath);
            if ([previousStatus[@"operationId"] isEqual:operationId]) {
                BOOL completed = [previousStatus[@"state"] isEqualToString:@"completed"];
                writeJSONFile(kResponsePath, @{@"ok": @YES, @"requested": @(!completed), @"resumed": @YES, @"completed": @(completed), @"operationId": operationId});
                return;
            }

            if (!gCatalogManager) {
                writeBridgeError(kResponsePath, @"catalog_unavailable", @"install", @"gCatalogManager not stashed yet", YES);
                return;
            }
            if (!gInstaller) {
                writeBridgeError(kResponsePath, @"installer_unavailable", @"install", @"gInstaller not stashed yet", YES);
                return;
            }

            NSNumber *appId = req[@"appId"];
            NSDictionary *buildDict = req[@"build"];
            if (!appId || !buildDict) {
                writeBridgeError(kResponsePath, @"invalid_request", @"install", @"missing appId or build", NO);
                return;
            }

            id<TFAppCatalogManagerProtocol> catalogManager = gCatalogManager;
            id app = [catalogManager getAppCatalogCachedAppForAppID:appId];
            if (!app) {
                writeBridgeError(kResponsePath, @"app_not_cached", @"install", @"getAppCatalogCachedAppForAppID: returned nil - is the catalog populated?", YES);
                return;
            }

            Class<TFAppBuildProtocol> buildCls = (Class<TFAppBuildProtocol>)objc_getClass("TFAppBuild");
            id build = [buildCls buildFromDictionary:buildDict];
            if (!build) {
                writeBridgeError(kResponsePath, @"invalid_build", @"install", @"buildFromDictionary: returned nil", NO);
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
                writeBridgeError(kResponsePath, @"installable_unavailable", @"install", @"initWithApp:build:... returned nil", YES);
                return;
            }

            autoinstallLog([NSString stringWithFormat:@"install: installable=%@", installable]);

            void (^completion)(void) = ^{
                autoinstallLog(@"install: completionBlock fired");
                writeJSONFile(kInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"completed"});
            };

            id<TFAppInstallerProtocol> installer = gInstaller;
            id result = [installer requestInstall:installable installationMode:0 alertDelegate:nil withBackgroundTaskMaster:nil completionBlock:completion];
            autoinstallLog([NSString stringWithFormat:@"install: requestInstall: returned %@", result]);
            writeJSONFile(kInstallStatusPath, @{@"ok": @YES, @"operationId": operationId, @"state": @"requested", @"appId": appId});
            writeJSONFile(kResponsePath, @{@"ok": @YES, @"requested": @YES, @"operationId": operationId});
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            writeBridgeError(kResponsePath, @"install_exception", @"install", [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason], YES);
        }
        return;
    }

    if ([action isEqualToString:@"list_trains"]) {
        NSString *appId = [req[@"appId"] stringValue];
        NSString *url = [NSString stringWithFormat:@"https://testflight.apple.com/v2/apps/%@/platforms/ios/trains", appId];
        fetchJSON(url, ^(id json, NSDictionary *error) {
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
        fetchJSON(url, ^(id json, NSDictionary *error) {
            if (error) {
                writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": error});
            } else {
                writeJSONFile(kResponsePath, @{@"ok": @YES, @"data": json});
            }
        });
        return;
    }

    if ([action isEqualToString:@"status"]) {
        NSMutableDictionary *response = [bridgeStatus() mutableCopy];
        response[@"ok"] = @YES;
        response[@"install"] = readJSONFile(kInstallStatusPath) ?: @{};
        writeJSONFile(kResponsePath, response);
        return;
    }

    if ([action isEqualToString:@"diagnostics"]) {
        writeJSONFile(kResponsePath, @{
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
        writeJSONFile(kResponsePath, @{@"ok": @YES});
        return;
    }

    writeBridgeError(kResponsePath, @"unknown_action", @"request", [NSString stringWithFormat:@"unknown action: %@", action], NO);
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

#pragma mark - App Store side: SKUIItemStateCenter purchase pipeline + PassKit sheet auto-confirm

static BOOL gIsAppStoreProcess = NO;
static BOOL gIsPassbookProcess = NO;

// The confirmation sheet is a stashed SwiftUI view controller (the PassKit authorization view, hosted
// in PassbookUIService). Reset per sheet so it's confirmed exactly once.
static id gStashedConfirmVC = nil;
static BOOL gConfirmDoneThisSheet = NO;

// SwiftUI exposes buttons as VIRTUAL accessibility elements (UIAccessibilityElement returned by
// -accessibilityElements / -accessibilityElementAtIndex:), NOT as real UIView subviews - so a plain
// subview walk finds nothing. Walk the accessibility tree instead, descending both AX children and
// real subviews.
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

// SwiftUI/UIKit only materialise their virtual accessibility elements when an accessibility client is
// active. Turn on the same automation server XCUITest uses (libAccessibility SPI) so -accessibilityElements
// actually returns the buttons; without this the AX tree is empty.
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

// Walk the stashed confirmation VC's accessibility tree and trigger the element whose class-or-label
// matches `match` (e.g. "Install") via the accessibility activation point - works for SwiftUI buttons
// that have no UIControl target-action.
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

// The confirmation sheet's SwiftUI content VC (PaymentUIBase AuthorizationViewHostingController)
// appears ~0.8s after the PassKit container, in PassbookUIService. Stash it, enable the AX server,
// and - if auto-confirm is armed via the flag file - activate its "Install" button, once per sheet.
%hook UIViewController

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (!gIsPassbookProcess) return;
    @try {
        NSString *cls = NSStringFromClass([self class]);
        if ([cls rangeOfString:@"AuthorizationViewHostingController"].location == NSNotFound) return;
        gStashedConfirmVC = self;
        autoinstallEnableAX();
        if (gConfirmDoneThisSheet) return;
        if (![[NSFileManager defaultManager] fileExistsAtPath:@"/tmp/autoinstall-autoconfirm.flag"]) return;
        gConfirmDoneThisSheet = YES;
        NSString *match = [NSString stringWithContentsOfFile:@"/tmp/autoinstall-autoconfirm.flag" encoding:NSUTF8StringEncoding error:nil];
        match = [match stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!match.length) match = @"Install";
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.6 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            NSArray *acted = autoinstallConfirmStashed(match);
            autoinstallLog([NSString stringWithFormat:@"[PB] auto-confirm match=%@ acted=%@", match, acted]);
        });
    } @catch (NSException *e) {}
}

%end

// A new PassKit authorization sheet is appearing - clear the once-guard so the SwiftUI hook above
// confirms exactly once for it.
%hook PKPaymentAuthorizationRemoteAlertViewController

- (void)viewDidAppear:(BOOL)animated {
    %orig;
    if (gIsPassbookProcess) gConfirmDoneThisSheet = NO;
}

%end

static NSString * const kASRequestPath = @"/tmp/autoinstall-as-request.json";
static NSString * const kASResponsePath = @"/tmp/autoinstall-as-response.json";
static NSString * const kASInstallStatusPath = @"/tmp/autoinstall-as-install-status.json";

static void handleAppStoreRequest(NSDictionary *req) {
    NSString *action = req[@"action"];
    autoinstallLog([NSString stringWithFormat:@"as-bridge: handling action=%@ req=%@", action, req]);

    if (![action isEqualToString:@"install"]) {
        writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
        return;
    }

    NSNumber *adamId = req[@"adamId"];
    NSNumber *versionId = req[@"versionId"];
    if (!adamId) {
        writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": @"missing adamId"});
        return;
    }

    // StoreKitUI's singletons require the main thread - defaultCenter/defaultContext returned nil when
    // called from the background bridge queue, worked once dispatched here.
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

            // +defaultContext is nil in the real App Store app; build one from the class's own fallback
            // config instead (it prints empty but is enough for the purchase pipeline to work).
            id<SKUIClientContextProtocol> clientContext = [contextCls defaultContext];
            if (!clientContext) {
                id fallbackConfig = [contextCls _fallbackConfigurationDictionary];
                clientContext = [[contextCls alloc] initWithConfigurationDictionary:fallbackConfig];
            }
            if (!center || !clientContext) {
                writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"center=%@ clientContext=%@", center, clientContext]});
                return;
            }

            id purchases = [center _newPurchasesWithItems:@[(id)item]];
            autoinstallLog([NSString stringWithFormat:@"as-install: adamId=%@ versionId=%@ purchases=%@", adamIdStr, versionId, purchases]);

            void (^completion)(id) = ^(id arg1) {
                autoinstallLog(@"as-install: completionBlock fired");
                writeJSONFile(kASInstallStatusPath, @{@"ok": @YES});
            };

            [center _performPurchases:purchases hasBundlePurchase:NO withClientContext:(id)clientContext completionBlock:completion];
            writeJSONFile(kASResponsePath, @{@"ok": @YES, @"requested": @YES});
        } @catch (NSException *exception) {
            autoinstallLog([NSString stringWithFormat:@"as-install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
            writeJSONFile(kASResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
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
