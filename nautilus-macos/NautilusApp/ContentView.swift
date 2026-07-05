import SwiftUI
import WebKit

struct WebView: NSViewRepresentable {
    let url: URL
    
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }
    
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Allow automatic media playback
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Allow developer tools (right click -> Inspect Element)
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 MovifyApp/1.0"
        webView.navigationDelegate = context.coordinator
        
        // Load the URL once here on creation to prevent the SwiftUI reload loop
        let request = URLRequest(url: url)
        webView.load(request)
        print("[WebView] Loading URL: \(url)")
        
        return webView
    }
    
    func updateNSView(_ nsView: WKWebView, context: Context) {
        // Intentionally left blank. Loading requests here causes an infinite reload loop in SwiftUI.
    }
    
    class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[WebView] Navigation failed: \(error.localizedDescription)")
        }
        
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[WebView] Provisional navigation failed: \(error.localizedDescription)")
        }
        
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("[WebView] Finished loading page successfully.")
        }
    }
}

struct ContentView: View {
    @State private var isServerReady = false
    @State private var attempts = 0
    
    var body: some View {
        Group {
            if isServerReady {
                WebView(url: URL(string: "http://127.0.0.1:8000/")!)
            } else {
                VStack(spacing: 20) {
                    ProgressView()
                        .scaleEffect(1.5)
                        .progressViewStyle(CircularProgressViewStyle(tint: .yellow))
                    Text("Starting Movify server...")
                        .font(.system(size: 16, weight: .semibold, design: .monospaced))
                        .foregroundColor(.yellow)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.08, green: 0.08, blue: 0.1))
                .onAppear {
                    checkServerHealth()
                }
            }
        }
        .frame(minWidth: 1000, minHeight: 650)
        .edgesIgnoringSafeArea(.all)
    }
    
    func checkServerHealth() {
        let url = URL(string: "http://127.0.0.1:8000/")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                DispatchQueue.main.async {
                    self.isServerReady = true
                }
            } else {
                // Retry in 250ms
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self.attempts += 1
                    // Max attempts 60 (15 seconds)
                    if self.attempts < 60 {
                        self.checkServerHealth()
                    } else {
                        // Fallback anyway to let WebView handle error
                        self.isServerReady = true
                    }
                }
            }
        }
        task.resume()
    }
}
