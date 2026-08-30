// lidangle — reads the MacBook lid angle sensor.
//
// The sensor is an Apple HID device (VID 0x05AC / PID 0x8104) on usage page 0x20
// ("Sensors"), usage 0x8A ("Orientation: Compound"). Its report descriptor declares
// report ID 1 as a single 9-bit field with logical and physical range 0...360, so the
// value is the lid angle in degrees with no scaling. It is declared as an Input report
// but answers a Feature request, which is how we poll it on demand.
//
// Usage:
//   lidangle            print the angle once, as a plain number
//   lidangle --json     print one JSON object
//   lidangle --watch    stream JSON lines at ~20 Hz until killed

import Foundation
import IOKit
import IOKit.hid

let kLidVendorID  = 0x05AC
let kLidProductID = 0x8104
let kLidUsagePage = 0x20
let kLidUsage     = 0x8A

// Held for the lifetime of the process: releasing the manager invalidates the device.
var hidManager: IOHIDManager?

func findLidSensor() -> IOHIDDevice? {
    let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
    hidManager = manager
    IOHIDManagerSetDeviceMatching(manager, [
        kIOHIDVendorIDKey as String:         kLidVendorID,
        kIOHIDProductIDKey as String:        kLidProductID,
        kIOHIDPrimaryUsagePageKey as String: kLidUsagePage,
        kIOHIDPrimaryUsageKey as String:     kLidUsage,
    ] as CFDictionary)
    IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
    guard let devices = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice>,
          let device = devices.first,
          IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone)) == kIOReturnSuccess
    else { return nil }
    return device
}

func readAngle(_ device: IOHIDDevice) -> Int? {
    var report = [UInt8](repeating: 0, count: 8)
    var length = report.count
    guard IOHIDDeviceGetReport(device, kIOHIDReportTypeFeature, 1, &report, &length) == kIOReturnSuccess,
          length >= 3, report[0] == 1
    else { return nil }
    return (Int(report[1]) | (Int(report[2]) << 8)) & 0x1FF   // 9-bit field
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = Set(CommandLine.arguments.dropFirst())

guard let device = findLidSensor() else {
    fail("lidangle: no lid angle sensor found (or it could not be opened)")
}

if args.contains("--watch") {
    setvbuf(stdout, nil, _IOLBF, 0)
    while true {
        if let angle = readAngle(device) {
            print("{\"angle\":\(angle),\"t\":\(Date().timeIntervalSince1970)}")
        }
        usleep(50_000) // 20 Hz
    }
} else {
    guard let angle = readAngle(device) else { fail("lidangle: sensor read failed") }
    if args.contains("--json") {
        print("{\"angle\":\(angle),\"t\":\(Date().timeIntervalSince1970)}")
    } else {
        print(angle)
    }
}
