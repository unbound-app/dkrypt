THEOS_PACKAGE_SCHEME=rootless
FINALPACKAGE=1
INSTALL_TARGET_PROCESSES = TestFlight SpringBoard

ARCHS := arm64
TARGET := iphone:clang:latest:15.0

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = tfauto
tfauto_FILES = $(shell find sources -name "*.x*" -o -name "*.m*")
tfauto_CFLAGS = -fobjc-arc
tfauto_FRAMEWORKS = Foundation UIKit

include $(THEOS_MAKE_PATH)/tweak.mk
