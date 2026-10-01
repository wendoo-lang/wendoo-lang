// String.rbx.ts (Roblox / roblox-ts implementation)
//
// Extends string interface with methods not available in roblox-ts
// rbxtsc automatically translates these to native Lua string methods

declare global {
  interface String {
    replace(searchValue: string, replaceValue: string): string;
    replaceAll(searchValue: string, replaceValue: string): string;
  }
}

/**
 * String utility functions for roblox-ts platform
 * These provide implementations for methods not available in roblox-ts
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
    return str.sub(position + 1, position + searchString.size()) === searchString;
  }

  /**
   * Extracts a substring from a string
   * @param str The source string
   * @param startIndex The starting index (0-based)
   * @param endIndex Optional ending index (0-based, exclusive). If omitted, extracts to end of string
   * @returns The extracted substring
   */
  export function substring(str: string, startIndex: number, endIndex?: number): string {
    const startPos = math.max(0, startIndex) + 1; // Convert to 1-based and ensure non-negative
    if (endIndex === undefined) {
      return str.sub(startPos);
    }
    const endPos = math.max(0, endIndex); // Ensure non-negative
    const actualStart = math.min(startPos - 1, endPos);
    const actualEnd = math.max(startPos - 1, endPos);
    return str.sub(actualStart + 1, actualEnd);
  }

  /**
   * Gets the length of a string
   * @param str The string to measure
   * @returns The length of the string
   */
  export function length(str: string): number {
    return str.size();
  }

  export function utf8ByteLength(str: string): number {
    return str.size();
  }

  export function charCodeAt(str: string, index: number): number {
    return str.byte(index + 1, index + 1)[0];
  }

  export function fromCharCode(...codes: number[]): string {
    return string.char(...codes);
  }

  export function mkid(len: number = 16, random: () => number = () => math.random()): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < len; i++) {
      const randIndex = math.floor(random() * chars.size()) + 1;
      result += chars.sub(randIndex, randIndex);
    }
    return result;
  }

  export function toString(value: unknown): string {
    return tostring(value);
  }

  /**
   * Repeats a string a specified number of times
   * @param str The string to repeat
   * @param count The number of times to repeat the string
   * @returns The repeated string
   */
  export function rep(str: string, count: number): string {
    let result = "";
    for (let i = 0; i < count; i++) {
      result += str;
    }
    return result;
  }

  export function trim(str: string): string {
    let [result] = str.gsub("^%s+", "");
    [result] = result.gsub("%s+$", "");
    return result;
  }

  export function charAt(str: string, pos: number): string {
    if (pos < 0 || pos >= str.size()) return "";
    return str.sub(pos + 1, pos + 1);
  }

  export function indexOf(str: string, searchString: string, position?: number): number {
    const startPos = (position ?? 0) + 1;
    if (searchString.size() === 0) return position ?? 0;
    const [found] = str.find(searchString, startPos, true);
    if (found === undefined) return -1;
    return found - 1;
  }

  export function lastIndexOf(str: string, searchString: string, position?: number): number {
    const maxPos = position !== undefined ? position : str.size() - 1;
    if (searchString.size() === 0) return math.min(maxPos, str.size());
    let lastFound = -1;
    let searchStart = 1;
    while (searchStart <= str.size()) {
      const [found] = str.find(searchString, searchStart, true);
      if (found === undefined) break;
      const zeroIdx = found - 1;
      if (zeroIdx > maxPos) break;
      lastFound = zeroIdx;
      searchStart = found + 1;
    }
    return lastFound;
  }

  export function slice(str: string, start?: number, endPos?: number): string {
    const len = str.size();
    let s = start ?? 0;
    let e = endPos ?? len;
    if (s < 0) s = math.max(len + s, 0);
    if (e < 0) e = math.max(len + e, 0);
    if (s >= e) return "";
    return str.sub(s + 1, e);
  }

  export function toLowerCase(str: string): string {
    return str.lower();
  }

  export function toUpperCase(str: string): string {
    return str.upper();
  }

  export function toLocaleUpperCase(str: string, _locale: string): string {
    return str.upper();
  }

  export function split(str: string, separator: string, limit?: number): string[] {
    const result: string[] = [];
    if (separator.size() === 0) {
      const max = limit !== undefined ? math.min(limit, str.size()) : str.size();
      for (let i = 0; i < max; i++) {
        result.push(str.sub(i + 1, i + 1));
      }
      return result;
    }
    let searchStart = 1;
    while (limit === undefined || result.size() < limit) {
      const [found, foundEnd] = str.find(separator, searchStart, true);
      if (found === undefined || foundEnd === undefined) {
        result.push(str.sub(searchStart));
        return result;
      }
      result.push(str.sub(searchStart, found - 1));
      searchStart = foundEnd + 1;
    }
    return result;
  }

  export function hash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.size(); i++) {
      const char = charCodeAt(str, i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return math.abs(hash);
  }
}
