// 只做两件公开、可逆的事：列出本机输出设备，或把默认输出切回其中一台。
// AirPlay 音箱在连上之前不会出现在这份列表里。
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void json_string(CFStringRef value) {
  char bytes[768];
  if (!value || !CFStringGetCString(value, bytes, sizeof(bytes), kCFStringEncodingUTF8)) {
    fputs("\"\"", stdout);
    return;
  }
  fputc('"', stdout);
  for (const unsigned char *p = (const unsigned char *)bytes; *p; p++) {
    if (*p == '"' || *p == '\\') fputc('\\', stdout);
    if (*p < 0x20) continue;
    fputc(*p, stdout);
  }
  fputc('"', stdout);
}

static const char *transport_name(UInt32 type) {
  switch (type) {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin";
    case kAudioDeviceTransportTypeBluetooth:
    case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth";
    case kAudioDeviceTransportTypeAirPlay: return "airplay";
    case kAudioDeviceTransportTypeVirtual: return "virtual";
    case kAudioDeviceTransportTypeUSB: return "usb";
    case kAudioDeviceTransportTypeHDMI: return "hdmi";
    case kAudioDeviceTransportTypeDisplayPort: return "displayport";
    case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt";
    default: return "other";
  }
}

static int has_output(AudioObjectID device) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyStreams,
    kAudioObjectPropertyScopeOutput,
    kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  return AudioObjectGetPropertyDataSize(device, &address, 0, NULL, &size) == noErr && size > 0;
}

static UInt32 transport_of(AudioObjectID device) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyTransportType,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
  };
  UInt32 value = 0;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &value) != noErr) return 0;
  return value;
}

static CFStringRef copy_device_string(AudioObjectID device, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = {
    selector,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
  };
  CFStringRef value = NULL;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &value) != noErr) return NULL;
  return value;
}

static AudioObjectID default_output(void) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
  };
  AudioObjectID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device);
  return device;
}

static int list_outputs(void) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) {
    fputs("{\"ok\":false,\"error\":\"list failed\"}\n", stdout);
    return 1;
  }
  UInt32 count = size / sizeof(AudioObjectID);
  AudioObjectID *devices = calloc(count ? count : 1, sizeof(AudioObjectID));
  if (!devices || AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, devices) != noErr) {
    free(devices);
    fputs("{\"ok\":false,\"error\":\"list failed\"}\n", stdout);
    return 1;
  }
  AudioObjectID current = default_output();
  fputs("{\"ok\":true,\"devices\":[", stdout);
  int first = 1;
  for (UInt32 i = 0; i < count; i++) {
    if (!has_output(devices[i])) continue;
    CFStringRef name = copy_device_string(devices[i], kAudioObjectPropertyName);
    CFStringRef uid = copy_device_string(devices[i], kAudioDevicePropertyDeviceUID);
    if (!first) fputc(',', stdout);
    first = 0;
    fputs("{\"uid\":", stdout);
    json_string(uid);
    fputs(",\"name\":", stdout);
    json_string(name);
    fprintf(stdout, ",\"audioId\":%u,\"transport\":\"%s\",\"output\":true,\"default\":%s}",
      (unsigned)devices[i],
      transport_name(transport_of(devices[i])),
      devices[i] == current ? "true" : "false");
    if (name) CFRelease(name);
    if (uid) CFRelease(uid);
  }
  fputs("]}\n", stdout);
  free(devices);
  return 0;
}

static int set_output(const char *uid) {
  if (!uid || !uid[0]) {
    fputs("{\"ok\":false,\"error\":\"missing uid\"}\n", stdout);
    return 1;
  }
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) {
    fputs("{\"ok\":false,\"error\":\"set failed\"}\n", stdout);
    return 1;
  }
  UInt32 count = size / sizeof(AudioObjectID);
  AudioObjectID *devices = calloc(count ? count : 1, sizeof(AudioObjectID));
  if (!devices || AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, devices) != noErr) {
    free(devices);
    fputs("{\"ok\":false,\"error\":\"set failed\"}\n", stdout);
    return 1;
  }
  AudioObjectID match = kAudioObjectUnknown;
  for (UInt32 i = 0; i < count; i++) {
    if (!has_output(devices[i])) continue;
    CFStringRef deviceUid = copy_device_string(devices[i], kAudioDevicePropertyDeviceUID);
    char bytes[768] = {0};
    if (deviceUid && CFStringGetCString(deviceUid, bytes, sizeof(bytes), kCFStringEncodingUTF8) && strcmp(bytes, uid) == 0) {
      match = devices[i];
    }
    if (deviceUid) CFRelease(deviceUid);
    if (match != kAudioObjectUnknown) break;
  }
  free(devices);
  if (match == kAudioObjectUnknown) {
    fputs("{\"ok\":false,\"error\":\"device not found\"}\n", stdout);
    return 1;
  }
  AudioObjectPropertyAddress output = {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
  };
  OSStatus status = AudioObjectSetPropertyData(kAudioObjectSystemObject, &output, 0, NULL, sizeof(match), &match);
  if (status != noErr) {
    fprintf(stdout, "{\"ok\":false,\"error\":\"set failed %d\"}\n", (int)status);
    return 1;
  }
  fputs("{\"ok\":true}\n", stdout);
  return 0;
}

// 这台 MacBook 上，控制中心图标在菜单栏最右侧附近。不截屏，避免弹出录屏授权。
static int find_icon(void) {
  CGRect bounds = CGDisplayBounds(CGMainDisplayID());
  double x = bounds.origin.x + bounds.size.width - 68;
  fprintf(stdout, "{\"ok\":true,\"x\":%.0f,\"y\":16,\"source\":\"menu-bar\"}\n", x);
  return 0;
}

static int print_cursor(void) {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = event ? CGEventGetLocation(event) : CGPointZero;
  if (event) CFRelease(event);
  fprintf(stdout, "{\"ok\":true,\"x\":%.2f,\"y\":%.2f}\n", point.x, point.y);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "list") == 0) return list_outputs();
  if (argc >= 3 && strcmp(argv[1], "set-uid") == 0) return set_output(argv[2]);
  if (argc >= 2 && strcmp(argv[1], "icon") == 0) return find_icon();
  if (argc >= 2 && strcmp(argv[1], "cursor") == 0) return print_cursor();
  fputs("{\"ok\":false,\"error\":\"usage\"}\n", stdout);
  return 2;
}
