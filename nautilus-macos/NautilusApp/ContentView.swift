import SwiftUI
import WebKit

struct WebView: NSViewRepresentable {
    let url: URL
    
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Allow automatic media playback
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Allow picture-in-picture
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 NautilusApp/1.0"
        
        return webView
    }
    
    func updateNSView(_ nsView: WKWebView, context: Context) {
        let request = URLRequest(url: url)
        nsView.load(request)
    }
}

struct ContentView: View {
    @State private var loadUrl = URL(string: "http://127.0.0.1:8000")!
    
    var body: some View {
        WebView(url: loadUrl)
            .frame(minWidth: 1000, minHeight: 650)
            .edgesIgnoringSafeArea(.all)
    }
}
