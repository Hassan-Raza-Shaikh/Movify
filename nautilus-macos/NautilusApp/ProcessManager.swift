import Foundation

class ProcessManager {
    static let shared = ProcessManager()
    private var process: Process?
    private var outputPipe: Pipe?
    
    // Project path
    private let projectPath = "/Users/hassan/Projects/Movify"
    
    func startBackend() {
        guard process == nil else {
            print("[ProcessManager] Backend already running.")
            return
        }
        
        let newProcess = Process()
        
        // List of candidate python paths to search, prioritized by environment
        let pythonPaths = [
            "\(projectPath)/.venv/bin/python",
            "/opt/miniconda3/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3"
        ]
        
        var selectedPythonPath: String?
        for path in pythonPaths {
            if FileManager.default.fileExists(atPath: path) {
                selectedPythonPath = path
                break
            }
        }
        
        // Fallback to /usr/bin/env python3 if none of the explicit paths exist
        if let pythonPath = selectedPythonPath {
            print("[ProcessManager] Found Python executable at: \(pythonPath)")
            newProcess.executableURL = URL(fileURLWithPath: pythonPath)
            newProcess.arguments = ["-m", "uvicorn", "src.api.main:app", "--host", "127.0.0.1", "--port", "8000"]
        } else {
            print("[ProcessManager] No explicit Python path found. Falling back to environment search.")
            newProcess.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            newProcess.arguments = ["python3", "-m", "uvicorn", "src.api.main:app", "--host", "127.0.0.1", "--port", "8000"]
        }
        
        newProcess.currentDirectoryURL = URL(fileURLWithPath: projectPath)
        
        // Capture output
        let pipe = Pipe()
        newProcess.standardOutput = pipe
        newProcess.standardError = pipe
        self.outputPipe = pipe
        
        // Log output asynchronously
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { return }
            if let output = String(data: data, encoding: .utf8) {
                print("[uvicorn] \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }
        
        do {
            print("[ProcessManager] Launching uvicorn backend from path: \(projectPath)...")
            try newProcess.run()
            self.process = newProcess
            print("[ProcessManager] Backend started successfully.")
        } catch {
            print("[ProcessManager] Failed to launch uvicorn process: \(error)")
        }
    }
    
    func stopBackend() {
        guard let activeProcess = process else { return }
        print("[ProcessManager] Stopping uvicorn process...")
        activeProcess.terminate()
        activeProcess.waitUntilExit()
        self.process = nil
        self.outputPipe = nil
        print("[ProcessManager] Backend process terminated.")
    }
    
    deinit {
        stopBackend()
    }
}
