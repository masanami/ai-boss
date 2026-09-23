import XCTest

/// TAP_LABEL のボタンを SpringBoard（システムダイアログ）→ TAP_BUNDLE（任意）の順に探してタップする。
final class TapperUITests: XCTestCase {
    func testTap() throws {
        let env = ProcessInfo.processInfo.environment
        let label = env["TAP_LABEL"] ?? "許可"
        let timeout = Double(env["TAP_TIMEOUT"] ?? "15") ?? 15
        var apps = [XCUIApplication(bundleIdentifier: "com.apple.springboard")]
        if let bundle = env["TAP_BUNDLE"] {
            let target = XCUIApplication(bundleIdentifier: bundle)
            // TAP_LAUNCH=1 なら対象アプリを APPENV_ 接頭辞の環境変数付きで起動し直す（ランナーが前面を奪うため）
            if env["TAP_LAUNCH"] == "1" {
                for (k, v) in env where k.hasPrefix("APPENV_") { target.launchEnvironment[String(k.dropFirst(7))] = v }
                target.launch()
            }
            apps.insert(target, at: 0)
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            for app in apps {
                let button = app.buttons[label]
                if button.exists { button.tap(); print("TAPPED: \(label)"); return }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("button not found: \(label)")
    }
}
