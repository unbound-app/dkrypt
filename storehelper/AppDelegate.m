#import "AppDelegate.h"
#import "AutoinstallRootViewController.h"
#import <objc/runtime.h>
#import <mach/mach_time.h>

#pragma mark - IOHID synthetic-touch SPI (adapted from OwnGoalStudio/TrollVNC's STHIDEventGenerator).
#pragma mark   Requires com.apple.private.hid.client.* entitlements in entitlements.plist - this is
#pragma mark   why this lives in a standalone app rather than the injected tweak, which can't add
#pragma mark   entitlements to an already-signed, already-running host process at runtime.

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

    IOHIDFloat pathMajorRadius = touching ? 5 : 0;
    uint32_t pathProximity = touching ? (kGSEventPathInfoInTouch | kGSEventPathInfoInRange) : 0;

    IOHIDEventRef subEvent = IOHIDEventCreateDigitizerFingerEvent(kCFAllocatorDefault, machTime, 2, 2, eventMask,
        normalizedPoint.x, normalizedPoint.y, 0, 0, 90.0,
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

static NSString * const kLogPath = @"/tmp/autoinstall-store.log";
static NSString * const kRequestPath = @"/tmp/autoinstall-taphelper-request.json";
static NSString * const kResponsePath = @"/tmp/autoinstall-taphelper-response.json";
static NSString * const kInstallStatusPath = @"/tmp/autoinstall-taphelper-install-status.json";

static void storeLog(NSString *line) {
    NSString *entry = [NSString stringWithFormat:@"[%@] %@\n", [NSDate date], line];
    if (![[NSFileManager defaultManager] fileExistsAtPath:kLogPath]) {
        [[NSFileManager defaultManager] createFileAtPath:kLogPath contents:nil attributes:nil];
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:kLogPath];
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

static void handleInstall(NSDictionary *req) {
    @try {
        NSNumber *adamId = req[@"adamId"];
        NSNumber *versionId = req[@"versionId"];
        if (!adamId) {
            writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"missing adamId"});
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
            writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"initWithLookupDictionary: returned nil"});
            return;
        }

        [(id)item setValue:offer forKey:@"_itemOffer"];
        [(id)item setValue:@"iosSoftware" forKey:@"_itemKindString"];
        if (versionId && versionId.longLongValue != 0) {
            [(id)item setValue:versionId forKey:@"_versionIdentifier"];
        }

        Class contextCls = objc_getClass("SKUIClientContext");
        id<SKUIItemStateCenterProtocol> center = [objc_getClass("SKUIItemStateCenter") defaultCenter];
        id<SKUIClientContextProtocol> clientContext = [contextCls defaultContext];
        if (!clientContext) {
            id fallbackConfig = [contextCls _fallbackConfigurationDictionary];
            storeLog([NSString stringWithFormat:@"install: defaultContext nil, fallbackConfig=%@", fallbackConfig]);
            clientContext = [[contextCls alloc] initWithConfigurationDictionary:fallbackConfig];
        }
        storeLog([NSString stringWithFormat:@"install: center=%@ clientContext=%@", center, clientContext]);
        if (!center || !clientContext) {
            writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"defaultCenter=%@ context=%@", center, clientContext]});
            return;
        }

        id purchases = [center _newPurchasesWithItems:@[(id)item]];
        storeLog([NSString stringWithFormat:@"install: adamId=%@ versionId=%@ purchases=%@", adamIdStr, versionId, purchases]);

        void (^completion)(id) = ^(id arg1) {
            storeLog([NSString stringWithFormat:@"install: completionBlock fired arg1=%@ class=%@", arg1, [arg1 class]]);
            NSMutableString *props = [NSMutableString string];
            for (NSString *key in @[@"error", @"jingleDocument", @"purchases", @"downloadMetadata", @"status", @"purchaseStatus", @"softwareItems", @"description", @"failureType", @"customerMessage"]) {
                @try {
                    id val = [arg1 valueForKey:key];
                    [props appendFormat:@"%@=%@ | ", key, val];
                } @catch (NSException *e) {}
            }
            storeLog([NSString stringWithFormat:@"install: response props: %@", props]);
            writeJSONFile(kInstallStatusPath, @{@"ok": @YES});
        };

        [center _performPurchases:purchases hasBundlePurchase:NO withClientContext:(id)clientContext completionBlock:completion];
        writeJSONFile(kResponsePath, @{@"ok": @YES, @"requested": @YES});
    } @catch (NSException *exception) {
        storeLog([NSString stringWithFormat:@"install: EXCEPTION name=%@ reason=%@", exception.name, exception.reason]);
        writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"exception: %@ %@", exception.name, exception.reason]});
    }
}

static void handleRequest(NSDictionary *req) {
    NSString *action = req[@"action"];
    storeLog([NSString stringWithFormat:@"handling action=%@ req=%@", action, req]);

    if ([action isEqualToString:@"install"]) {
        handleInstall(req);
        return;
    }

    if ([action isEqualToString:@"status"]) {
        writeJSONFile(kResponsePath, @{@"ok": @YES, @"running": @YES});
        return;
    }

    if ([action isEqualToString:@"tap"]) {
        NSNumber *x = req[@"x"];
        NSNumber *y = req[@"y"];
        if (!x || !y) {
            writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": @"missing x/y"});
            return;
        }
        autoinstallSynthesizeTap(CGPointMake([x doubleValue], [y doubleValue]));
        storeLog([NSString stringWithFormat:@"tap: synthesized at (%@, %@)", x, y]);
        writeJSONFile(kResponsePath, @{@"ok": @YES});
        return;
    }

    writeJSONFile(kResponsePath, @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]});
}

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:[[AutoinstallRootViewController alloc] init]];
    self.window.rootViewController = nav;
    [self.window makeKeyAndVisible];

    storeLog([NSString stringWithFormat:@"AutoinstallStore launched (Preferences+StoreKitUI linked), SKUIItemStateCenter class=%@, starting bridge", objc_getClass("SKUIItemStateCenter")]);

    dispatch_queue_t queue = dispatch_queue_create("dev.adrian.autoinstallstore.bridge", DISPATCH_QUEUE_SERIAL);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 200);
    dispatch_source_set_event_handler(timer, ^{
        NSFileManager *fm = [NSFileManager defaultManager];
        if (![fm fileExistsAtPath:kRequestPath]) return;

        NSData *data = [NSData dataWithContentsOfFile:kRequestPath];
        [fm removeItemAtPath:kRequestPath error:nil];
        if (!data) return;

        NSError *err = nil;
        NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
        if (!req) {
            storeLog([NSString stringWithFormat:@"bad request json: %@", err]);
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            handleRequest(req);
        });
    });
    dispatch_resume(timer);
    objc_setAssociatedObject(self, "bridgeTimer", timer, OBJC_ASSOCIATION_RETAIN);

    return YES;
}

// The bridge polling timer stops firing once iOS suspends the app's run loop in the background -
// keep it alive with a background task assertion (standard ~30s-3min grace period) so taps can
// still be dispatched while App Store, not this app, is the frontmost/visible app.
- (void)applicationDidEnterBackground:(UIApplication *)application {
    __block UIBackgroundTaskIdentifier taskId = UIBackgroundTaskInvalid;
    taskId = [application beginBackgroundTaskWithName:@"autoinstall-taphelper" expirationHandler:^{
        [application endBackgroundTask:taskId];
    }];
    storeLog([NSString stringWithFormat:@"entered background, started background task id=%lu", (unsigned long)taskId]);
}

@end
