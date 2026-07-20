#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDLib.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MIN_INTERVAL_MS 100
#define MAX_INTERVAL_MS 5000

typedef struct {
  IOHIDManagerRef manager;
  IOHIDDeviceRef device;
  IOHIDElementRef element;
} CapsLockLed;

static volatile sig_atomic_t running = 1;

static void stop_running(int signal_number) {
  (void)signal_number;
  running = 0;
}

static bool is_internal_keyboard(IOHIDDeviceRef device) {
  CFTypeRef product =
      IOHIDDeviceGetProperty(device, CFSTR(kIOHIDProductKey));
  return product && CFGetTypeID(product) == CFStringGetTypeID() &&
         CFStringCompare((CFStringRef)product,
                         CFSTR("Apple Internal Keyboard / Trackpad"), 0) ==
             kCFCompareEqualTo;
}

static bool open_caps_lock_led(CapsLockLed *led) {
  led->manager =
      IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
  if (!led->manager) return false;

  IOHIDManagerSetDeviceMatching(led->manager, NULL);
  if (IOHIDManagerOpen(led->manager, kIOHIDOptionsTypeNone) !=
      kIOReturnSuccess) {
    return false;
  }

  CFSetRef devices = IOHIDManagerCopyDevices(led->manager);
  if (!devices) return false;

  CFIndex device_count = CFSetGetCount(devices);
  const void **device_list =
      calloc((size_t)device_count, sizeof(*device_list));
  if (!device_list) {
    CFRelease(devices);
    return false;
  }
  CFSetGetValues(devices, device_list);

  for (CFIndex i = 0; i < device_count && !led->element; i++) {
    IOHIDDeviceRef device = (IOHIDDeviceRef)device_list[i];
    if (!is_internal_keyboard(device)) continue;

    CFArrayRef elements = IOHIDDeviceCopyMatchingElements(
        device, NULL, kIOHIDOptionsTypeNone);
    if (!elements) continue;

    for (CFIndex j = 0; j < CFArrayGetCount(elements); j++) {
      IOHIDElementRef element =
          (IOHIDElementRef)CFArrayGetValueAtIndex(elements, j);
      if (IOHIDElementGetUsagePage(element) == kHIDPage_LEDs &&
          IOHIDElementGetUsage(element) == kHIDUsage_LED_CapsLock &&
          IOHIDElementGetType(element) == kIOHIDElementTypeOutput) {
        led->device = (IOHIDDeviceRef)CFRetain(device);
        led->element = (IOHIDElementRef)CFRetain(element);
        break;
      }
    }
    CFRelease(elements);
  }

  free(device_list);
  CFRelease(devices);
  return led->element != NULL;
}

static bool set_led(const CapsLockLed *led, bool on) {
  IOHIDValueRef value = IOHIDValueCreateWithIntegerValue(
      kCFAllocatorDefault, led->element, 0, on ? 1 : 0);
  if (!value) return false;
  IOReturn result = IOHIDDeviceSetValue(led->device, led->element, value);
  CFRelease(value);
  return result == kIOReturnSuccess;
}

static bool logical_caps_lock_is_on(void) {
  return (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) &
          kCGEventFlagMaskAlphaShift) != 0;
}

static void close_caps_lock_led(CapsLockLed *led) {
  if (led->element) CFRelease(led->element);
  if (led->device) CFRelease(led->device);
  if (led->manager) {
    IOHIDManagerClose(led->manager, kIOHIDOptionsTypeNone);
    CFRelease(led->manager);
  }
}

static int blink(CapsLockLed *led, int interval_ms) {
  bool on = true;
  bool restore_on_exit = true;
  if (!set_led(led, on)) return 2;

  struct pollfd parent = {
      .fd = STDIN_FILENO,
      .events = POLLIN | POLLHUP,
  };

  while (running) {
    int poll_result = poll(&parent, 1, interval_ms);
    if (poll_result > 0) {
      char command = '\0';
      if ((parent.revents & POLLIN) != 0 && read(STDIN_FILENO, &command, 1) == 1 &&
          command == 'q') {
        restore_on_exit = false;
      }
      break;
    }
    if (poll_result < 0) {
      if (errno == EINTR) continue;
      break;
    }
    on = !on;
    if (!set_led(led, on)) break;
  }

  if (restore_on_exit) set_led(led, logical_caps_lock_is_on());
  return 0;
}

static bool parse_interval(const char *source, int *interval_ms) {
  char *end = NULL;
  long parsed = strtol(source, &end, 10);
  if (!end || *end != '\0' || parsed < MIN_INTERVAL_MS ||
      parsed > MAX_INTERVAL_MS) {
    return false;
  }
  *interval_ms = (int)parsed;
  return true;
}

int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) return 64;

  signal(SIGINT, stop_running);
  signal(SIGTERM, stop_running);
  signal(SIGHUP, stop_running);

  CapsLockLed led = {0};
  if (!open_caps_lock_led(&led)) {
    fprintf(stderr, "Built-in Caps Lock LED is unavailable\n");
    close_caps_lock_led(&led);
    return 1;
  }

  int result = 0;
  if (strcmp(argv[1], "on") == 0 && argc == 2) {
    result = set_led(&led, true) ? 0 : 2;
  } else if (strcmp(argv[1], "restore") == 0 && argc == 2) {
    result = set_led(&led, logical_caps_lock_is_on()) ? 0 : 2;
  } else if (strcmp(argv[1], "blink") == 0 && argc == 3) {
    int interval_ms = 0;
    result = parse_interval(argv[2], &interval_ms) ? blink(&led, interval_ms)
                                                   : 64;
  } else {
    result = 64;
  }

  close_caps_lock_led(&led);
  return result;
}
