#import "AutoinstallRootViewController.h"

@implementation AutoinstallRootViewController

- (NSMutableArray *)specifiers {
    if (!_specifiers) {
        _specifiers = [NSMutableArray new];
    }
    return _specifiers;
}

@end
