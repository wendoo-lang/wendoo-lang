/**
 * Saves `content` as a file named `filename` through the browser's download
 * flow. Inside a sandboxed frame the sandbox must carry `allow-downloads`, or
 * the browser drops the download.
 * @param mimeType the media type the file is saved with
 */
export function downloadTextFile(content: string, filename: string, mimeType = "application/json"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Opens the browser's file chooser and resolves with the file the user picks,
 * or `undefined` when they cancel or pick none.
 * @param accept the chooser's file filter, in the `accept` attribute's form (".brain", ".wendoo,.json")
 */
export function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => {
      resolve(input.files?.[0]);
    });
    input.addEventListener("cancel", () => {
      resolve(undefined);
    });
    input.click();
  });
}
