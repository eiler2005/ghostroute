// Canonical vector artwork. Regenerate with: swift tools/render-icons.swift assets
import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor { CGColor(red: r/255, green: g/255, blue: b/255, alpha: 1) }
func draw(_ size: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
    context.scaleBy(x: CGFloat(size)/1024, y: CGFloat(size)/1024)
    let tile = CGPath(roundedRect: CGRect(x: 58, y: 58, width: 908, height: 908), cornerWidth: 208, cornerHeight: 208, transform: nil)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -14), blur: 28, color: CGColor(gray: 0, alpha: 0.22))
    context.setFillColor(color(15, 29, 45));context.addPath(tile);context.fillPath()
    context.restoreGState()
    context.saveGState();context.addPath(tile);context.clip()
    let background = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [color(34, 58, 78), color(10, 22, 37)] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(background, start: CGPoint(x: 100, y: 950), end: CGPoint(x: 850, y: 80), options: [])
    context.restoreGState()
    context.addPath(tile);context.setStrokeColor(CGColor(gray: 1, alpha: 0.13));context.setLineWidth(3);context.strokePath()
    let shield = CGMutablePath()
    shield.move(to: CGPoint(x: 512, y: 808))
    shield.addCurve(to: CGPoint(x: 755, y: 709), control1: CGPoint(x: 603, y: 781), control2: CGPoint(x: 684, y: 748))
    shield.addLine(to: CGPoint(x: 740, y: 482))
    shield.addCurve(to: CGPoint(x: 512, y: 224), control1: CGPoint(x: 731, y: 366), control2: CGPoint(x: 639, y: 281))
    shield.addCurve(to: CGPoint(x: 284, y: 482), control1: CGPoint(x: 385, y: 281), control2: CGPoint(x: 293, y: 366))
    shield.addLine(to: CGPoint(x: 269, y: 709))
    shield.addCurve(to: CGPoint(x: 512, y: 808), control1: CGPoint(x: 340, y: 748), control2: CGPoint(x: 421, y: 781));shield.closeSubpath()
    context.saveGState();context.setShadow(offset: CGSize(width: 0, height: -10), blur: 32, color: CGColor(gray: 0, alpha: 0.24))
    context.addPath(shield);context.setFillColor(color(125, 231, 199));context.fillPath();context.restoreGState()
    context.saveGState();context.addPath(shield);context.clip()
    let mint = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [color(205, 255, 227), color(88, 211, 193)] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(mint, start: CGPoint(x: 340, y: 808), end: CGPoint(x: 740, y: 224), options: []);context.restoreGState()
    let route = CGMutablePath()
    route.move(to: CGPoint(x: 620, y: 620))
    route.addCurve(to: CGPoint(x: 402, y: 600), control1: CGPoint(x: 548, y: 699), control2: CGPoint(x: 427, y: 686))
    route.addCurve(to: CGPoint(x: 451, y: 424), control1: CGPoint(x: 372, y: 523), control2: CGPoint(x: 394, y: 459))
    route.addCurve(to: CGPoint(x: 620, y: 469), control1: CGPoint(x: 511, y: 384), control2: CGPoint(x: 593, y: 408))
    route.addLine(to: CGPoint(x: 620, y: 525));route.addLine(to: CGPoint(x: 528, y: 525))
    context.addPath(route);context.setLineWidth(48);context.setLineCap(.round);context.setLineJoin(.round);context.setStrokeColor(color(18, 44, 55));context.strokePath()
    context.setFillColor(color(247, 255, 251));context.fillEllipse(in: CGRect(x: 606, y: 606, width: 28, height: 28))
    return bitmap.representation(using: .png, properties: [:])!
}
for size in [16, 32, 48, 128, 256, 512, 1024] { try draw(size).write(to: output.appendingPathComponent("icon-\(size).png")) }
let iconset = output.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try draw(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try draw(size*2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let process = Process();process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("AppIcon.icns").path]
try process.run();process.waitUntilExit();guard process.terminationStatus == 0 else { exit(1) }
try FileManager.default.removeItem(at: iconset)
print("Generated app and Chrome icons")
