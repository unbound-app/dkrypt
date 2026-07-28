THEOS_PACKAGE_SCHEME=rootless
FINALPACKAGE=1
INSTALL_TARGET_PROCESSES = TestFlight SpringBoard AppStore

ARCHS := arm64
TARGET := iphone:clang:latest:15.0

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = autoinstall
autoinstall_FILES = $(shell find sources -name "*.x*" -o -name "*.m*")
autoinstall_CFLAGS = -fobjc-arc -DBRIDGE_VERSION='@"$(THEOS_PACKAGE_BASE_VERSION)"'
autoinstall_FRAMEWORKS = Foundation UIKit

include $(THEOS_MAKE_PATH)/tweak.mk
