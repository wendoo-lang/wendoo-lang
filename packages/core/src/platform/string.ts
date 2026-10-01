// Base string interface extensions and utils
// This file exists for TypeScript module resolution consistency
// Actual implementations are platform-specific

/**
 * Cross-platform string utility functions
 * Platform-specific implementations provide the actual functionality
 */
export namespace StringUtils {
  /**
   * Checks if a string starts with the specified prefix
   * @param str The string to check
   * @param searchString The prefix to search for
   * @param position Optional starting position (default: 0)
   * @returns true if str starts with searchString at the given position
   */
  export declare function startsWith(str: string, searchString: string, position?: number): boolean;

  /**
   * Extracts a substring from a string
   * @param str The source string
   * @param start The starting index (0-based)
   * @param end Optional ending index (0-based, exclusive). If omitted, extracts to end of string
   * @returns The extracted substring
   */
  export declare function substring(str: string, start: number, end?: number): string;

  /**
   * Gets the length of a string
   * @param str The string to measure
   * @returns The length of the string
   */
  export declare function length(str: string): number;

  /**
   * Gets the number of bytes the UTF-8 encoding of a string occupies. An
   * unpaired UTF-16 surrogate counts as the three bytes of the replacement
   * character it encodes as.
   * @param str The string to measure
   * @returns The UTF-8 byte length of the string
   */
  export declare function utf8ByteLength(str: string): number;

  /**
   * Gets the character code at the specified index in a string
   * @param str The source string
   * @param index The index of the character (0-based)
   * @returns The character code at the specified index
   */
  export declare function charCodeAt(str: string, index: number): number;

  /**
   * Creates a string from one or more character codes
   * @param codes One or more character codes
   * @returns The string created from the character codes
   */
  export declare function fromCharCode(...codes: number[]): string;

  /**
   * Generates a UUID-like string identifier.
   * @param len Identifier length in characters (default 16).
   * @param random Source of [0, 1) random values (default platform RNG). Pass a
   *   seeded source to produce reproducible identifiers.
   * @returns A UUID-like string
   */
  export declare function mkid(len?: number, random?: () => number): string;

  /**
   * Converts a value to its string representation
   * @param value The value to convert
   * @returns The string representation of the value
   */
  export declare function toString(value: unknown): string;

  /**
   * Repeats a string a specified number of times
   * @param str The string to repeat
   * @param count The number of times to repeat the string
   * @returns The repeated string
   */
  export declare function rep(str: string, count: number): string;

  /**
   * Trims whitespace from both ends of a string
   * @param str The string to trim
   * @returns The trimmed string
   */
  export declare function trim(str: string): string;

  /**
   * Gets the character at the specified index in a string
   * @param str The source string
   * @param pos The index of the character (0-based)
   * @returns The character at the specified index, or empty string if out of range
   */
  export declare function charAt(str: string, pos: number): string;

  /**
   * Returns the index of the first occurrence of a search string
   * @param str The string to search within
   * @param searchString The string to search for
   * @param position Optional index to start searching from (default: 0)
   * @returns The index of the first occurrence, or -1 if not found
   */
  export declare function indexOf(str: string, searchString: string, position?: number): number;

  /**
   * Returns the index of the last occurrence of a search string
   * @param str The string to search within
   * @param searchString The string to search for
   * @param position Optional index to start searching backwards from
   * @returns The index of the last occurrence, or -1 if not found
   */
  export declare function lastIndexOf(str: string, searchString: string, position?: number): number;

  /**
   * Extracts a section of a string, supporting negative indices
   * @param str The source string
   * @param start The start index (negative counts from end)
   * @param end Optional end index (negative counts from end, exclusive)
   * @returns The extracted section
   */
  export declare function slice(str: string, start?: number, end?: number): string;

  /**
   * Converts all characters in a string to lowercase
   * @param str The string to convert
   * @returns The lowercase string
   */
  export declare function toLowerCase(str: string): string;

  /**
   * Converts all characters in a string to uppercase
   * @param str The string to convert
   * @returns The uppercase string
   */
  export declare function toUpperCase(str: string): string;

  /**
   * Converts all characters in a string to uppercase under the casing rules of
   * a locale: a Turkish locale maps a dotless `i` to its dotted capital. On the
   * Roblox target the invariant mapping applies for every locale.
   * @param str The string to convert
   * @param locale BCP-47-style locale code whose casing rules apply
   * @returns The uppercase string
   */
  export declare function toLocaleUpperCase(str: string, locale: string): string;

  /**
   * Splits a string into an array of substrings using the specified separator
   * @param str The string to split
   * @param separator The string to use as a separator
   * @param limit Optional maximum number of substrings to return
   * @returns An array of substrings
   */
  export declare function split(str: string, separator: string, limit?: number): string[];

  /**
   * Simple string hashing function.
   * @param str The string to hash
   * @returns A non-negative integer hash of the string
   */
  export declare function hash(str: string): number;
}
