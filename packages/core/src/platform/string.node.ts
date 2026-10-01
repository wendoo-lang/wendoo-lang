// String.node.ts (Node.js implementation)
//
// Node.js target uses native JavaScript string methods
// No extensions needed - all string methods are available by default

/**
 * String utility functions for Node.js platform
 * These delegate to native JavaScript string methods
 */
export namespace StringUtils {
  /**
   * Checks if a string starts with the specified prefix
   * @param str The string to check
   * @param searchString The prefix to search for
   * @param position Optional starting position (default: 0)
   * @returns true if str starts with searchString at the given position
   */
  export function startsWith(str: string, searchString: string, position = 0): boolean {
    return str.startsWith(searchString, position);
  }

  /**
   * Extracts a substring from a string
   * @param str The source string
   * @param start The starting index (0-based)
   * @param end Optional ending index (0-based, exclusive). If omitted, extracts to end of string
   * @returns The extracted substring
   */
  export function substring(str: string, start: number, end?: number): string {
    return str.substring(start, end);
  }

  /**
   * Gets the length of a string
   * @param str The string to measure
   * @returns The length of the string
   */
  export function length(str: string): number {
    return str.length;
  }

  export function utf8ByteLength(str: string): number {
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
      const unit = str.charCodeAt(i);
      if (unit < 0x80) {
        bytes += 1;
      } else if (unit < 0x800) {
        bytes += 2;
      } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  export function charCodeAt(str: string, index: number): number {
    return str.charCodeAt(index);
  }

  export function fromCharCode(...codes: number[]): string {
    return String.fromCharCode(...codes);
  }

  export function mkid(len: number = 16, random: () => number = Math.random): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < len; i++) {
      const randIndex = Math.floor(random() * chars.length);
      result += chars.charAt(randIndex);
    }
    return result;
  }

  export function toString(value: unknown): string {
    return String(value);
  }

  /**
   * Repeats a string a specified number of times
   * @param str The string to repeat
   * @param count The number of times to repeat the string
   * @returns The repeated string
   */
  export function rep(str: string, count: number): string {
    return str.repeat(count);
  }

  export function trim(str: string): string {
    return str.trim();
  }

  export function charAt(str: string, pos: number): string {
    return str.charAt(pos);
  }

  export function indexOf(str: string, searchString: string, position?: number): number {
    return str.indexOf(searchString, position);
  }

  export function lastIndexOf(str: string, searchString: string, position?: number): number {
    return position !== undefined ? str.lastIndexOf(searchString, position) : str.lastIndexOf(searchString);
  }

  export function slice(str: string, start?: number, end?: number): string {
    return str.slice(start, end);
  }

  export function toLowerCase(str: string): string {
    return str.toLowerCase();
  }

  export function toUpperCase(str: string): string {
    return str.toUpperCase();
  }

  export function toLocaleUpperCase(str: string, locale: string): string {
    return str.toLocaleUpperCase(locale);
  }

  export function split(str: string, separator: string, limit?: number): string[] {
    return str.split(separator, limit);
  }

  export function hash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}
