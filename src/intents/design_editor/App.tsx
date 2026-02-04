import { useState, useRef, useEffect, useCallback } from "react";
import { Button, Text, Title } from "@canva/app-ui-kit";
import { Archive, FolderCheck, XCircle } from "lucide-react";
import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SelectedFile = { file: File; path: string; name: string };
type Status = "idle" | "has-files" | "converting" | "done";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [processedHtml, setProcessedHtml] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<{
    text: string;
    type: "success" | "error";
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // Auto-dismiss messages
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(
      () => setMessage(null),
      message.type === "success" ? 5000 : 10000,
    );
    return () => clearTimeout(t);
  }, [message]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const reset = useCallback(() => {
    setFiles([]);
    setProcessedHtml(null);
    setFolderName(null);
    setStatus("idle");
    setMessage(null);
  }, []);

  const extractZip = useCallback(async (zipFile: File) => {
    try {
      const zip = new JSZip();
      const data = await zip.loadAsync(zipFile);
      const extracted: SelectedFile[] = [];

      for (const [relativePath, entry] of Object.entries(data.files)) {
        if (entry.dir) continue;
        try {
          const blob = await entry.async("blob");
          const name = relativePath.split("/").pop() || relativePath;
          extracted.push({
            file: new File([blob], name, { type: blob.type }),
            path: relativePath,
            name,
          });
        } catch {
          console.warn(`Skipped ${relativePath}`);
        }
      }

      if (extracted.length === 0) {
        setMessage({ text: "That file is empty or couldn't be read.", type: "error" });
        return;
      }

      setFiles(extracted);
      setStatus("has-files");
    } catch (err) {
      setMessage({
        text: "Couldn't open that file: " + ((err as Error).message || ""),
        type: "error",
      });
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.endsWith(".zip")) {
        setFolderName(file.name);
        extractZip(file);
      } else {
        setMessage({ text: "Please drop your Canva export here.", type: "error" });
      }
    },
    [extractZip],
  );

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file?.name.endsWith(".zip")) {
        setFolderName(file.name);
        extractZip(file);
      }
      e.target.value = "";
    },
    [extractZip],
  );

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  const hasHtml = files.some((f) => f.name.toLowerCase().endsWith(".html"));
  const hasImages = files.some((f) => {
    const nl = f.name.toLowerCase();
    const pl = f.path.toLowerCase();
    return (
      (nl.endsWith(".png") || nl.endsWith(".jpg") || nl.endsWith(".jpeg")) &&
      (pl.includes("images/") || pl.includes("images\\"))
    );
  });
  const isReady = hasHtml && hasImages;

  // -----------------------------------------------------------------------
  // Conversion
  // -----------------------------------------------------------------------

  const processFiles = async () => {
    if (!isReady) return;
    setStatus("converting");
    setMessage(null);

    try {
      if (!BACKEND_HOST) {
        throw new Error(
          "Backend not configured. Set CANVA_BACKEND_HOST before building.",
        );
      }

      const formData = new FormData();

      // Find HTML file (prefer index.html → email.html → any .html)
      const htmlFile =
        files.find(
          (f) =>
            f.name.toLowerCase() === "index.html" ||
            f.path.toLowerCase().includes("index.html"),
        ) ||
        files.find(
          (f) =>
            f.name.toLowerCase() === "email.html" ||
            f.path.toLowerCase().includes("email.html"),
        ) ||
        files.find((f) => f.name.toLowerCase().endsWith(".html"));

      if (!htmlFile) throw new Error("Something's not right with that export. Try again.");
      formData.append("index.html", htmlFile.file);

      // Add image files (preserve original-case path)
      files.forEach((f) => {
        const nl = f.name.toLowerCase();
        const pl = f.path.toLowerCase();
        if (
          (nl.endsWith(".png") || nl.endsWith(".jpg") || nl.endsWith(".jpeg")) &&
          (pl.includes("images/") || pl.includes("images\\"))
        ) {
          formData.append("images", f.file, f.path.replace(/\\/g, "/"));
        }
      });

      const res = await fetch(`${BACKEND_HOST}/api/process`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        let msg = `Error ${res.status}`;
        try {
          const e = await res.json();
          msg = e.error || msg;
        } catch {
          // ignore parse failure
        }
        throw new Error(msg);
      }

      const result = await res.json();
      if (!result.html) throw new Error("Something went wrong. Please try again.");

      setProcessedHtml(result.html);
      setStatus("done");
    } catch (err) {
      setMessage({
        text: (err as Error).message || "Something went wrong",
        type: "error",
      });
      setStatus("has-files");
    }
  };

  // -----------------------------------------------------------------------
  // Copy
  // -----------------------------------------------------------------------

  const copyHtml = async () => {
    if (!processedHtml) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(processedHtml);
      } else {
        // Fallback for browsers without clipboard API
        const ta = document.createElement("textarea");
        ta.value = processedHtml;
        ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setMessage({ text: "Copied! Paste it into your email.", type: "success" });
    } catch {
      setMessage({ text: "Copy failed. Try again.", type: "error" });
    }
  };

  // -----------------------------------------------------------------------
  // Render — done state
  // -----------------------------------------------------------------------

  if (status === "done") {
    return (
      <div style={S.root}>
        <Title size="medium">Your email is ready</Title>
        <Text size="small">
          Paste it into Outlook or any email sender.
        </Text>

        <Button variant="primary" onClick={copyHtml}>
          Copy to clipboard
        </Button>

        <Button variant="tertiary" onClick={reset}>
          Start again
        </Button>

        {message && <MessageBanner {...message} />}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render — idle / has-files / converting
  // -----------------------------------------------------------------------

  return (
    <div style={S.root}>
      <Title size="medium">Canva to Outlook</Title>
      <Text size="small">
        Export your email from Canva, then drop the file here to get it ready for Outlook.
      </Text>

      {/* Drop zone */}
      <div
        style={S.dropZone(dragOver, status === "has-files")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => zipInputRef.current?.click()}
      >
        <div style={S.iconWrap}>
          {status === "has-files" ? (
            <FolderCheck size={36} color="#4caf50" />
          ) : (
            <Archive size={36} color="#667eea" />
          )}
        </div>

        <Text size="small">
          {status === "has-files" ? "File selected" : "Drag & drop your export here"}
        </Text>
        {status !== "has-files" && (
          <Text size="small" tone="secondary">
            or click to browse
          </Text>
        )}

        {/* Selected file badge */}
        {folderName && status === "has-files" && (
          <div style={S.badge}>
            <span style={S.badgeText}>{folderName}</span>
            <button
              style={S.cancelBtn}
              onClick={(e) => {
                e.stopPropagation();
                reset();
              }}
              title="Clear selection"
            >
              <XCircle size={15} color="#dc3545" />
            </button>
          </div>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        style={{ display: "none" }}
        onChange={onFileSelect}
      />

      {/* File list preview */}
      {files.length > 0 && (
        <div style={S.fileList}>
          {files.slice(0, 10).map((f, i) => (
            <div key={i} style={S.fileItem}>
              <span style={S.fileName}>{f.name}</span>
              <span style={S.fileSize}>{formatSize(f.file.size)}</span>
            </div>
          ))}
          {files.length > 10 && (
            <div style={{ ...S.fileItem, color: "#999", fontSize: "13px" }}>
              ... and {files.length - 10} more
            </div>
          )}
        </div>
      )}

      {/* Validation warning */}
      {status === "has-files" && !isReady && (
        <Text size="small" tone="critical">
          That doesn't look like a Canva email export. Try exporting again.
        </Text>
      )}

      {/* Convert button */}
      {status === "has-files" && isReady && (
        <Button variant="primary" onClick={processFiles}>
          Prepare email
        </Button>
      )}

      {/* Converting — disabled button acts as loading indicator */}
      {status === "converting" && (
        <Button variant="primary" disabled>
          Preparing…
        </Button>
      )}

      {/* Message banner */}
      {message && <MessageBanner {...message} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBanner
// ---------------------------------------------------------------------------

function MessageBanner({ text, type }: { text: string; type: "success" | "error" }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: "6px",
        fontSize: "13px",
        background: type === "success" ? "#d4edda" : "#f8d7da",
        color: type === "success" ? "#155724" : "#721c24",
        border: `1px solid ${type === "success" ? "#c3e6cb" : "#f5c6cb"}`,
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), 2);
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + ["B", "KB", "MB"][i];
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S = {
  root: {
    padding: "20px 16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  } as React.CSSProperties,

  iconWrap: {
    display: "flex",
    justifyContent: "center",
    marginBottom: "4px",
  } as React.CSSProperties,

  dropZone: (dragOver: boolean, hasFiles: boolean): React.CSSProperties => ({
    border: `2px dashed ${hasFiles ? "#4caf50" : dragOver ? "#764ba2" : "#667eea"}`,
    borderRadius: "8px",
    padding: "20px 12px",
    textAlign: "center",
    background: hasFiles ? "#f1f8f4" : dragOver ? "#f0f0ff" : "#f8f9ff",
    cursor: "pointer",
    transition: "all 0.2s ease",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
  }),

  badge: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: "8px",
    padding: "5px 8px",
    background: "#f1f8f4",
    borderRadius: "6px",
    width: "100%",
  } as React.CSSProperties,

  badgeText: {
    color: "#4caf50",
    fontSize: "13px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as React.CSSProperties,

  cancelBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
  } as React.CSSProperties,

  fileList: {
    background: "#f5f5f5",
    borderRadius: "6px",
    padding: "8px 10px",
    maxHeight: "140px",
    overflowY: "auto",
  } as React.CSSProperties,

  fileItem: {
    display: "flex",
    justifyContent: "space-between",
    padding: "3px 0",
    borderBottom: "1px solid #eee",
  } as React.CSSProperties,

  fileName: {
    fontWeight: 500,
    fontSize: "13px",
    color: "#333",
  } as React.CSSProperties,

  fileSize: {
    color: "#999",
    fontSize: "11px",
  } as React.CSSProperties,

};
