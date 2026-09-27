import type { FolderErrorPayload } from "@wendoo/bridge-protocol";
import { FOLDER_SESSION_PROTOCOL_VERSION, FolderSessionErrorCode } from "@wendoo/bridge-protocol";

/**
 * The host's answer to the protocol version a `folder:hello` declares.
 *
 * - Accepted: `protocolVersion` is the app's declared version, which the
 *   session speaks and the `folder:welcome` carries.
 * - Refused: `error` is the `folder:error` payload to post to the app, and
 *   `extensionUpdateNotice`, when present, is the message to show the user,
 *   whose remedy is updating this extension.
 */
export type FolderHelloVerdict =
  | { readonly accepted: true; readonly protocolVersion: number }
  | { readonly accepted: false; readonly error: FolderErrorPayload; readonly extensionUpdateNotice?: string };

/**
 * Judge the protocol version a `folder:hello` declares. Any whole version
 * from 1 up to {@link FOLDER_SESSION_PROTOCOL_VERSION} is accepted as the
 * session's version. A newer version is refused with
 * `PROTOCOL_VERSION_NEWER` and an extension-update notice; a missing or
 * malformed version is refused with `INVALID_PAYLOAD` and no notice.
 */
export function judgeFolderHello(declared: unknown): FolderHelloVerdict {
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1) {
    return {
      accepted: false,
      error: {
        code: FolderSessionErrorCode.INVALID_PAYLOAD,
        message: "folder:hello must declare a whole protocol version of 1 or more",
      },
    };
  }
  if (declared > FOLDER_SESSION_PROTOCOL_VERSION) {
    return {
      accepted: false,
      error: {
        code: FolderSessionErrorCode.PROTOCOL_VERSION_NEWER,
        message: `This app speaks folder-session protocol version ${declared}, newer than this host's ${FOLDER_SESSION_PROTOCOL_VERSION}; update the Wendoo extension to open the project.`,
      },
      extensionUpdateNotice:
        "This project's app needs a newer version of the Wendoo extension. Update the extension to open the project.",
    };
  }
  return { accepted: true, protocolVersion: declared };
}
