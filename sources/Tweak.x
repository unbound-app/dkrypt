#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <objc/runtime.h>

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

#pragma mark - App Store side: SKUIItemStateCenter probe (validation only, no purchase calls yet)

static NSString * const kASRequestPath = @"/tmp/autoinstall-as-request.json";
static NSString * const kASResponsePath = @"/tmp/autoinstall-as-response.json";

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

%ctor {
    NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier];
    autoinstallLog([NSString stringWithFormat:@"autoinstall loaded into pid %d bundle %@",
        [[NSProcessInfo processInfo] processIdentifier], bundleId]);

    if (isSpringBoard()) {
        startSpringBoardSide();
    } else if ([bundleId isEqualToString:@"com.apple.AppStore"]) {
        startAppStoreSide();
    } else {
        startTestFlightSide();
    }
}
