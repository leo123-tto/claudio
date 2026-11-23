import AVFoundation
import AudioToolbox
import Foundation

// 只把这一路音频送到指定设备，不改系统默认输出。
// 用法：play-device <audioId> <文件> <音量0到1>
// 标准输入：pause / resume / stop / volume 0.4

final class ExclusivePlayer {
  let player = AVAudioPlayerNode()
  let engine = AVAudioEngine()
  var volume: Float = 1
  var started = false

  func start(device: AudioDeviceID, file: AVAudioFile) throws {
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
    guard let unit = engine.outputNode.audioUnit else {
      throw NSError(domain: "claudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有音频输出"])
    }
    var deviceID = device
    let status = AudioUnitSetProperty(
      unit,
      kAudioOutputUnitProperty_CurrentDevice,
      kAudioUnitScope_Global,
      0,
      &deviceID,
      UInt32(MemoryLayout<AudioDeviceID>.size))
    if status != noErr {
      throw NSError(domain: "claudio", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "没能单独接到这只音箱"])
    }
    player.volume = volume
    try engine.start()
    let seconds = file.processingFormat.sampleRate > 0
      ? Double(file.length) / file.processingFormat.sampleRate
      : 0
    emit(["event": "ready", "seconds": seconds])
    player.scheduleFile(file, at: nil) { [weak self] in
      self?.emit(["event": "ended"])
      exit(0)
    }
    player.play()
    started = true
  }

  func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
  }

  func handle(_ line: String) {
    if line == "pause" {
      player.pause()
    } else if line == "resume" {
      player.play()
    } else if line == "stop" {
      player.stop()
      engine.stop()
      exit(0)
    } else if line.hasPrefix("volume ") {
      let value = Float(line.dropFirst(7)) ?? volume
      volume = min(1, max(0, value))
      player.volume = volume
    }
  }
}

let arguments = CommandLine.arguments
guard arguments.count >= 3, let deviceNumber = UInt32(arguments[1]) else {
  fputs("{\"event\":\"error\",\"message\":\"参数不够\"}\n", stdout)
  exit(2)
}

let session = ExclusivePlayer()
if arguments.count >= 4, let requested = Float(arguments[3]) {
  session.volume = min(1, max(0, requested))
}

do {
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: arguments[2]))
  try session.start(device: AudioDeviceID(deviceNumber), file: file)
} catch {
  let message = (error as NSError).localizedDescription
  session.emit(["event": "error", "message": message])
  exit(1)
}

Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
  guard session.started,
        let nodeTime = session.player.lastRenderTime,
        let playerTime = session.player.playerTime(forNodeTime: nodeTime) else { return }
  let seconds = playerTime.sampleRate > 0 ? Double(playerTime.sampleTime) / playerTime.sampleRate : 0
  session.emit(["event": "pos", "seconds": max(0, seconds)])
}

DispatchQueue.global().async {
  while let line = readLine() {
    session.handle(line.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}

RunLoop.main.run()
