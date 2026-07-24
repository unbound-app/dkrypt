DEBUG = 0
FINALPACKAGE = 1
THEOS_PACKAGE_SCHEME = rootless

ARCHS := arm64
TARGET := iphone:clang:16.5:15.0

include $(THEOS)/makefiles/common.mk

APPLICATION_NAME = autoinstall
autoinstall_FILES = main.m AppDelegate.m AutoinstallRootViewController.m
autoinstall_FRAMEWORKS = UIKit Foundation IOKit
autoinstall_PRIVATE_FRAMEWORKS = Preferences StoreKitUI
autoinstall_CFLAGS = -fobjc-arc
autoinstall_CODESIGN_FLAGS = -Sentitlements.plist

include $(THEOS_MAKE_PATH)/application.mk
