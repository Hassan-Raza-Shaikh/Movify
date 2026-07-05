import SwiftUI

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        ProcessManager.shared.startBackend()
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        ProcessManager.shared.stopBackend()
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

@main
struct NautilusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .navigationTitle("Nautilus")
        }
        .windowStyle(.automatic)
    }
}
