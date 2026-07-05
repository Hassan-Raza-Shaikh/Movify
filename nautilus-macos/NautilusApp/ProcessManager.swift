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
        let pythonPath = "\(projectPath)/.venv/bin/python"
        
        // Check if venv python exists, fallback to system python3
        if FileManager.default.fileExists(atPath: pythonPath) {
            newProcess.executableURL = URL(fileURLWithPath: pythonPath)
        } else {
            newProcess.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            newProcess.arguments = ["python3"]
        }
        
        // Arguments to start uvicorn
        var args = ["-m", "uvicorn", "src.api.main:app", "--host", "127.0.0.1", "--port", "8000"]
        if newProcess.executableURL?.lastPathComponent == "env" {
            args.insert("python3", at: 0)
        }
        newProcess.arguments = args
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
