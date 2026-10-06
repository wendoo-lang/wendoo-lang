import type { ITileLanguageMetadata, TileSentenceFrame } from "@wendoo/core/brain";
import type { ActionKind } from "@wendoo/core/runtime";
import ts from "typescript";
import { DescriptorDiagCode } from "./diag-codes.js";
import { shorthandValueExpression } from "./type-ref.js";
import type {
  CompileDiagnostic,
  ExtractedArgSpec,
  ExtractedConversionParts,
  ExtractedDescriptor,
  ExtractedOutput,
  ExtractedParam,
  SourceSpan,
} from "./types.js";

/** Source constructor name of each action kind's default-export call. */
const kActionConstructorNames: Record<ActionKind, string> = {
  sensor: "Sensor",
  actuator: "Actuator",
  conversion: "Conversion",
};

/** Result of {@link extractDescriptor}: the descriptor (when extraction succeeded) plus any diagnostics. */
export interface ExtractionResult {
  descriptor?: ExtractedDescriptor;
  diagnostics: CompileDiagnostic[];
}

/** Walk the source file's default export and extract a {@link ExtractedDescriptor} from a `Sensor({...})`, `Actuator({...})`, or `Conversion({...})` call. */
export function extractDescriptor(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ExtractionResult {
  const diagnostics: CompileDiagnostic[] = [];

  function addDiag(code: DescriptorDiagCode, node: ts.Node, message: string): void {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    diagnostics.push({
      code,
      message,
      severity: "error",
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    });
  }

  function spanOf(node: ts.Node): SourceSpan {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    };
  }

  let defaultExport: ts.ExportAssignment | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      defaultExport = statement;
    }
  }

  if (!defaultExport) {
    diagnostics.push({
      code: DescriptorDiagCode.MissingDefaultExport,
      message:
        "Missing default export. Expected `export default Sensor({...})`, `Actuator({...})`, or `Conversion({...})`.",
      severity: "error",
      line: 1,
      column: 1,
    });
    return { diagnostics };
  }

  const expr = defaultExport.expression;
  if (!ts.isCallExpression(expr)) {
    addDiag(
      DescriptorDiagCode.InvalidDefaultExport,
      expr,
      "Default export must be a call to `Sensor({...})`, `Actuator({...})`, or `Conversion({...})`."
    );
    return { diagnostics };
  }

  if (!ts.isIdentifier(expr.expression)) {
    addDiag(
      DescriptorDiagCode.InvalidDefaultExport,
      expr.expression,
      "Default export must be a call to `Sensor({...})`, `Actuator({...})`, or `Conversion({...})`."
    );
    return { diagnostics };
  }

  const callee = expr.expression.text;
  const matchedKind = (Object.keys(kActionConstructorNames) as ActionKind[]).find(
    (k) => kActionConstructorNames[k] === callee
  );
  if (matchedKind === undefined) {
    addDiag(
      DescriptorDiagCode.InvalidDefaultExport,
      expr.expression,
      "Default export must be a call to `Sensor({...})`, `Actuator({...})`, or `Conversion({...})`."
    );
    return { diagnostics };
  }

  if (expr.arguments.length !== 1) {
    addDiag(
      DescriptorDiagCode.InvalidCalleeArgumentCount,
      expr,
      `\`${callee}()\` must be called with exactly one argument.`
    );
    return { diagnostics };
  }

  const arg = expr.arguments[0];
  if (!ts.isObjectLiteralExpression(arg)) {
    addDiag(
      DescriptorDiagCode.CalleeArgumentNotObjectLiteral,
      arg,
      `\`${callee}()\` argument must be an object literal.`
    );
    return { diagnostics };
  }

  if (matchedKind === "conversion") {
    return extractConversionDescriptor(sourceFile, checker, arg, addDiag, diagnostics);
  }

  const kind: "sensor" | "actuator" = matchedKind;

  let id: string | undefined;
  let name: string | undefined;
  let configReturnType: string | undefined;
  let returnTypeNode: ts.Expression | undefined;
  let configConsumesWhenResult: string | undefined;
  let consumesWhenResultNode: ts.Expression | undefined;
  let args: ExtractedArgSpec[] = [];
  let onExecuteNode: ts.FunctionExpression | ts.MethodDeclaration | ts.ArrowFunction | undefined;
  let execIsAsync = false;
  let onPageEnteredNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null = null;
  let onPageExitedNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null = null;
  let label: string | undefined;
  let icon: string | undefined;
  let iconSpan: SourceSpan | undefined;
  let docs: string | undefined;
  let docsSpan: SourceSpan | undefined;
  let tags: string[] | undefined;
  let language: ITileLanguageMetadata | undefined;
  let inline = false;
  let inlineNode: ts.Expression | undefined;
  let presenceGated = false;
  let outputs: ExtractedOutput[] | undefined;

  for (const prop of arg.properties) {
    if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
      if (prop.name.text === "onExecute") {
        onExecuteNode = prop;
        execIsAsync = prop.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      } else if (prop.name.text === "onPageEntered") {
        onPageEnteredNode = prop;
      } else if (prop.name.text === "onPageExited") {
        onPageExitedNode = prop;
      }
      continue;
    }
    const member = configMember(prop, checker, addDiag);
    if (!member) continue;
    const value = member.value;
    switch (member.name) {
      case "id":
        if (ts.isStringLiteral(value)) {
          id = value.text;
        } else {
          addDiag(DescriptorDiagCode.IdMustBeStringLiteral, value, "`id` must be a string literal.");
        }
        break;

      case "name":
        if (ts.isStringLiteral(value)) {
          name = value.text;
        } else {
          addDiag(DescriptorDiagCode.NameMustBeStringLiteral, value, "`name` must be a string literal.");
        }
        break;

      case "returnType":
        if (ts.isStringLiteral(value)) {
          configReturnType = value.text;
        } else if (ts.isIdentifier(value)) {
          configReturnType = value.text;
          returnTypeNode = value;
        } else {
          addDiag(
            DescriptorDiagCode.ReturnTypeMustBeNameOrRef,
            value,
            "`returnType` must be a type name string literal or a type reference."
          );
        }
        break;

      case "consumesWhenResult":
        if (ts.isStringLiteral(value)) {
          configConsumesWhenResult = value.text;
        } else if (ts.isIdentifier(value)) {
          configConsumesWhenResult = value.text;
          consumesWhenResultNode = value;
        } else {
          addDiag(
            DescriptorDiagCode.ConsumesWhenResultMustBeNameOrRef,
            value,
            "`consumesWhenResult` must be a type name string literal or a type reference."
          );
        }
        break;

      case "args":
        args = extractArgs(value, checker, addDiag);
        break;

      case "onExecute":
        if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
          onExecuteNode = value;
          execIsAsync = value.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
        } else {
          addDiag(DescriptorDiagCode.OnExecuteMustBeFunction, value, "`onExecute` must be a function.");
        }
        break;

      case "onPageEntered":
        if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
          onPageEnteredNode = value;
        } else {
          addDiag(DescriptorDiagCode.OnPageEnteredMustBeFunction, value, "`onPageEntered` must be a function.");
        }
        break;

      case "onPageExited":
        if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
          onPageExitedNode = value;
        } else {
          addDiag(DescriptorDiagCode.OnPageExitedMustBeFunction, value, "`onPageExited` must be a function.");
        }
        break;

      case "label":
        if (ts.isStringLiteral(value)) {
          label = value.text;
        } else {
          addDiag(DescriptorDiagCode.LabelMustBeStringLiteral, value, "`label` must be a string literal.");
        }
        break;

      case "icon":
        if (ts.isStringLiteral(value)) {
          icon = value.text;
          iconSpan = spanOf(value);
        } else {
          addDiag(DescriptorDiagCode.IconMustBeStringLiteral, value, "`icon` must be a string literal.");
        }
        break;

      case "docs":
        if (ts.isStringLiteral(value)) {
          docs = value.text;
          docsSpan = spanOf(value);
        } else {
          addDiag(DescriptorDiagCode.DocsMustBeStringLiteral, value, "`docs` must be a string literal.");
        }
        break;

      case "tags":
        if (ts.isArrayLiteralExpression(value)) {
          tags = [];
          for (const elem of value.elements) {
            if (ts.isStringLiteral(elem)) {
              tags.push(elem.text);
            } else {
              addDiag(
                DescriptorDiagCode.TagElementMustBeStringLiteral,
                elem,
                "Each element of `tags` must be a string literal."
              );
            }
          }
        } else {
          addDiag(DescriptorDiagCode.TagsMustBeArrayLiteral, value, "`tags` must be an array literal.");
        }
        break;

      case "language":
        language = extractTileLanguage(value, checker, addDiag);
        break;

      case "inline":
        inlineNode = value;
        if (value.kind === ts.SyntaxKind.TrueKeyword) {
          inline = true;
        } else if (value.kind === ts.SyntaxKind.FalseKeyword) {
          inline = false;
        } else {
          addDiag(DescriptorDiagCode.InlineMustBeBoolean, value, "`inline` must be a boolean literal.");
        }
        break;

      case "presenceGated":
        if (value.kind === ts.SyntaxKind.TrueKeyword) {
          presenceGated = true;
        } else if (value.kind === ts.SyntaxKind.FalseKeyword) {
          presenceGated = false;
        } else {
          addDiag(DescriptorDiagCode.PresenceGatedMustBeBoolean, value, "`presenceGated` must be a boolean literal.");
        }
        break;

      case "outputs":
        outputs = extractOutputs(value, checker, addDiag);
        break;
    }
  }

  if (name === undefined) {
    addDiag(DescriptorDiagCode.NamePropertyRequired, arg, "`name` property is required.");
  }
  if (onExecuteNode === undefined) {
    addDiag(DescriptorDiagCode.OnExecuteRequired, arg, "`onExecute` method is required.");
  }
  if (kind === "sensor" && inline && args.length > 0) {
    addDiag(
      DescriptorDiagCode.InlineSensorTakesNoArgs,
      inlineNode ?? arg,
      "An inline sensor takes no arguments; remove `args` or `inline: true`."
    );
  }

  let returnType: string | undefined;
  let returnTypeAnnotation: ts.TypeNode | undefined;
  if (kind === "sensor" && onExecuteNode) {
    if (configReturnType !== undefined) {
      returnType = configReturnType;
    } else {
      const annotated = extractReturnType(onExecuteNode, execIsAsync, addDiag);
      returnType = annotated?.name;
      returnTypeAnnotation = annotated?.node;
    }
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return {
    descriptor: {
      kind,
      id,
      idInsertOffset: arg.getStart(sourceFile) + 1,
      name: name!,
      returnType: kind === "sensor" ? returnType : undefined,
      returnTypeNode: kind === "sensor" ? returnTypeNode : undefined,
      returnTypeAnnotation,
      consumesWhenResult: configConsumesWhenResult,
      consumesWhenResultNode,
      args,
      execIsAsync,
      onExecuteNode: onExecuteNode!,
      onPageEnteredNode,
      onPageExitedNode,
      label,
      icon,
      iconSpan,
      docs,
      docsSpan,
      tags,
      language,
      inline: kind === "sensor" ? inline : undefined,
      presenceGated: kind === "sensor" ? presenceGated : undefined,
      outputs,
    },
    diagnostics: [],
  };
}

/** Diagnostic sink shared by the extraction helpers. */
type AddDiag = (code: DescriptorDiagCode, node: ts.Node, message: string) => void;

/**
 * Resolve one config object member to its name and value expression. A plain
 * `name: value` member yields its initializer; a shorthand member yields the
 * referenced declaration's initializer. A spread member or an unresolvable
 * shorthand yields undefined after pushing its diagnostic; other member kinds
 * yield undefined for the caller to handle.
 */
function configMember(
  prop: ts.ObjectLiteralElementLike,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): { name: string; value: ts.Expression } | undefined {
  if (ts.isSpreadAssignment(prop)) {
    addDiag(
      DescriptorDiagCode.ConfigMemberNotInline,
      prop,
      "Config members must be written inline; spread is not supported."
    );
    return undefined;
  }
  if (ts.isPropertyAssignment(prop)) {
    const name = getPropertyName(prop);
    if (name === undefined) return undefined;
    return { name, value: prop.initializer };
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    const value = shorthandValueExpression(prop, checker);
    if (!value) {
      addDiag(
        DescriptorDiagCode.ShorthandMemberUnresolvable,
        prop,
        `Shorthand \`${prop.name.text}\` does not resolve to a declared value.`
      );
      return undefined;
    }
    return { name: prop.name.text, value };
  }
  return undefined;
}

/**
 * Extract a conversion descriptor from a `Conversion({...})` config object.
 * Validates member shapes (`from`/`to` present, `cost` a positive numeric
 * literal, `convert` a synchronous single-parameter function); the `from`/`to`
 * expressions are carried unresolved and resolve to type names during
 * compilation. The `convert` function is carried as the descriptor's
 * `onExecuteNode`.
 */
function extractConversionDescriptor(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  arg: ts.ObjectLiteralExpression,
  addDiag: (code: DescriptorDiagCode, node: ts.Node, message: string) => void,
  diagnostics: CompileDiagnostic[]
): ExtractionResult {
  let id: string | undefined;
  let fromNode: ts.Expression | undefined;
  let toNode: ts.Expression | undefined;
  let cost: number | undefined;
  let costSeen = false;
  let convertSeen = false;
  let convertNode: ts.FunctionExpression | ts.MethodDeclaration | ts.ArrowFunction | undefined;

  const checkConvertNode = (node: ts.FunctionExpression | ts.MethodDeclaration | ts.ArrowFunction): void => {
    const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
    if (isAsync) {
      addDiag(DescriptorDiagCode.ConversionConvertMustBeSync, node, "`convert` must be a synchronous function.");
      return;
    }
    if (node.parameters.length !== 1) {
      addDiag(
        DescriptorDiagCode.ConversionConvertParamCount,
        node,
        "`convert` must take exactly one parameter (the value to convert)."
      );
      return;
    }
    convertNode = node;
  };

  for (const prop of arg.properties) {
    if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name) && prop.name.text === "convert") {
      convertSeen = true;
      checkConvertNode(prop);
      continue;
    }
    const member = configMember(prop, checker, addDiag);
    if (!member) continue;
    const value = member.value;
    switch (member.name) {
      case "id":
        if (ts.isStringLiteral(value)) {
          id = value.text;
        } else {
          addDiag(DescriptorDiagCode.IdMustBeStringLiteral, value, "`id` must be a string literal.");
        }
        break;
      case "from":
        fromNode = value;
        break;
      case "to":
        toNode = value;
        break;
      case "cost":
        costSeen = true;
        if (ts.isNumericLiteral(value) && Number.parseFloat(value.text) > 0) {
          cost = Number.parseFloat(value.text);
        } else {
          addDiag(
            DescriptorDiagCode.ConversionCostMustBePositiveNumber,
            value,
            "`cost` must be a positive numeric literal."
          );
        }
        break;
      case "convert":
        convertSeen = true;
        if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
          checkConvertNode(value);
        } else {
          addDiag(DescriptorDiagCode.ConversionConvertMustBeFunction, value, "`convert` must be an inline function.");
        }
        break;
    }
  }

  if (fromNode === undefined) {
    addDiag(DescriptorDiagCode.ConversionTypeRequired, arg, "`from` property is required.");
  }
  if (toNode === undefined) {
    addDiag(DescriptorDiagCode.ConversionTypeRequired, arg, "`to` property is required.");
  }
  if (!costSeen) {
    addDiag(DescriptorDiagCode.ConversionCostMustBePositiveNumber, arg, "`cost` property is required.");
  }
  if (!convertSeen) {
    addDiag(DescriptorDiagCode.ConversionConvertRequired, arg, "`convert` function is required.");
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  return {
    descriptor: {
      kind: "conversion",
      id,
      idInsertOffset: arg.getStart(sourceFile) + 1,
      name: "conversion",
      returnType: undefined,
      args: [],
      execIsAsync: false,
      onExecuteNode: convertNode!,
      onPageEnteredNode: null,
      onPageExitedNode: null,
      conversion: { fromNode: fromNode!, toNode: toNode!, cost: cost! },
    },
    diagnostics: [],
  };
}

/** The frame names a `language.frame` member may spell. */
const kTileSentenceFrames: readonly TileSentenceFrame[] = ["verb", "state", "event"];

function isTileSentenceFrame(text: string): text is TileSentenceFrame {
  return (kTileSentenceFrames as readonly string[]).includes(text);
}

/**
 * Extract the `language` group of a sensor or actuator config: a
 * `{ form?, frame?, bare? }` object literal whose members are string literals,
 * with `frame` spelling one of the frame names. Each malformed member yields
 * its own diagnostic and is dropped; a `language` value that is not an object
 * literal yields undefined.
 */
function extractTileLanguage(
  node: ts.Expression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ITileLanguageMetadata | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    addDiag(DescriptorDiagCode.LanguageMustBeObjectLiteral, node, "`language` must be an object literal.");
    return undefined;
  }

  let form: string | undefined;
  let frame: TileSentenceFrame | undefined;
  let bare: string | undefined;

  for (const prop of node.properties) {
    const member = configMember(prop, checker, addDiag);
    if (!member) continue;
    const value = member.value;
    switch (member.name) {
      case "form":
        if (ts.isStringLiteral(value)) {
          form = value.text;
        } else {
          addDiag(
            DescriptorDiagCode.LanguageFormMustBeStringLiteral,
            value,
            "`language.form` must be a string literal."
          );
        }
        break;
      case "frame":
        if (ts.isStringLiteral(value) && isTileSentenceFrame(value.text)) {
          frame = value.text;
        } else {
          addDiag(
            DescriptorDiagCode.LanguageFrameMustBeFrameName,
            value,
            "`language.frame` must be the string literal `verb`, `state`, or `event`."
          );
        }
        break;
      case "bare":
        if (ts.isStringLiteral(value)) {
          bare = value.text;
        } else {
          addDiag(
            DescriptorDiagCode.LanguageBareMustBeStringLiteral,
            value,
            "`language.bare` must be a string literal."
          );
        }
        break;
    }
  }

  return { form, frame, bare };
}

/** Extract and validate the `outputs` array of a sensor config. Each malformed entry yields a precise diagnostic; valid entries are returned. */
function extractOutputs(node: ts.Expression, checker: ts.TypeChecker, addDiag: AddDiag): ExtractedOutput[] {
  if (!ts.isArrayLiteralExpression(node)) {
    addDiag(DescriptorDiagCode.OutputsMustBeArrayLiteral, node, "`outputs` must be an array literal.");
    return [];
  }

  const result: ExtractedOutput[] = [];
  const seenNames = new Set<string>();
  for (const elem of node.elements) {
    const output = extractOutput(elem, checker, addDiag);
    if (!output) continue;
    if (seenNames.has(output.name)) {
      addDiag(
        DescriptorDiagCode.DuplicateOutputName,
        elem,
        `Duplicate output name \`${output.name}\`. Output names must be unique within a sensor.`
      );
      continue;
    }
    seenNames.add(output.name);
    result.push(output);
  }
  return result;
}

/** Extract a single `outputs` entry: a `{ name, type, label?, icon?, docs?, tags?, writableResult? }` object literal. */
function extractOutput(node: ts.Expression, checker: ts.TypeChecker, addDiag: AddDiag): ExtractedOutput | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    addDiag(DescriptorDiagCode.OutputEntryMustBeObjectLiteral, node, "Each `outputs` entry must be an object literal.");
    return undefined;
  }

  let name: string | undefined;
  let type: string | undefined;
  let typeNode: ts.Expression | undefined;
  let label: string | undefined;
  let icon: string | undefined;
  let docs: string | undefined;
  let tags: string[] | undefined;
  let writableResult: boolean | undefined;

  for (const prop of node.properties) {
    const member = configMember(prop, checker, addDiag);
    if (!member) continue;
    const value = member.value;
    switch (member.name) {
      case "name":
        if (ts.isStringLiteral(value)) {
          name = value.text;
        } else {
          addDiag(DescriptorDiagCode.OutputNameMustBeStringLiteral, value, "Output `name` must be a string literal.");
        }
        break;
      case "writableResult":
        if (value.kind === ts.SyntaxKind.TrueKeyword) {
          writableResult = true;
        } else if (value.kind === ts.SyntaxKind.FalseKeyword) {
          writableResult = false;
        } else {
          addDiag(
            DescriptorDiagCode.OutputWritableResultMustBeBoolean,
            value,
            "Output `writableResult` must be a boolean literal."
          );
        }
        break;
      case "type":
        if (ts.isStringLiteral(value)) {
          type = value.text;
        } else if (ts.isIdentifier(value)) {
          type = value.text;
          typeNode = value;
        } else {
          addDiag(
            DescriptorDiagCode.OutputTypeMustBeStringLiteral,
            value,
            "Output `type` must be a type name string literal or a type reference."
          );
        }
        break;
      case "label":
        if (ts.isStringLiteral(value)) {
          label = value.text;
        } else {
          addDiag(DescriptorDiagCode.OutputLabelMustBeStringLiteral, value, "Output `label` must be a string literal.");
        }
        break;
      case "icon":
        if (ts.isStringLiteral(value)) {
          icon = value.text;
        } else {
          addDiag(DescriptorDiagCode.OutputIconMustBeStringLiteral, value, "Output `icon` must be a string literal.");
        }
        break;
      case "docs":
        if (ts.isStringLiteral(value)) {
          docs = value.text;
        } else {
          addDiag(DescriptorDiagCode.OutputDocsMustBeStringLiteral, value, "Output `docs` must be a string literal.");
        }
        break;
      case "tags":
        if (ts.isArrayLiteralExpression(value)) {
          tags = [];
          for (const tagElem of value.elements) {
            if (ts.isStringLiteral(tagElem)) {
              tags.push(tagElem.text);
            } else {
              addDiag(
                DescriptorDiagCode.OutputTagElementMustBeStringLiteral,
                tagElem,
                "Each element of an output's `tags` must be a string literal."
              );
            }
          }
        } else {
          addDiag(DescriptorDiagCode.OutputTagsMustBeArrayLiteral, value, "Output `tags` must be an array literal.");
        }
        break;
    }
  }

  if (name === undefined) {
    addDiag(DescriptorDiagCode.OutputNameRequired, node, "Each `outputs` entry must have a `name` property.");
  }
  if (type === undefined) {
    addDiag(DescriptorDiagCode.OutputTypeRequired, node, "Each `outputs` entry must have a `type` property.");
  }
  if (name === undefined || type === undefined) return undefined;

  const result: ExtractedOutput = { name, type, label, icon, docs, tags };
  if (typeNode) {
    result.typeNode = typeNode;
  }
  if (writableResult !== undefined) {
    result.writableResult = writableResult;
  }
  return result;
}

function extractArgs(node: ts.Expression, checker: ts.TypeChecker, addDiag: AddDiag): ExtractedArgSpec[] {
  if (!ts.isArrayLiteralExpression(node)) {
    addDiag(DescriptorDiagCode.ArgsMustBeArrayLiteral, node, "`args` must be an array literal.");
    return [];
  }

  const result: ExtractedArgSpec[] = [];
  for (const elem of node.elements) {
    const spec = extractArgSpec(elem, checker, addDiag);
    if (spec) result.push(spec);
  }
  return result;
}

function extractArgSpec(node: ts.Expression, checker: ts.TypeChecker, addDiag: AddDiag): ExtractedArgSpec | undefined {
  if (!ts.isCallExpression(node)) {
    addDiag(
      DescriptorDiagCode.ArgSpecMustBeCallExpression,
      node,
      "Each arg spec must be a call expression (e.g., `param(...)`, `modifier(...)`, `choice(...)`)."
    );
    return undefined;
  }

  if (!ts.isIdentifier(node.expression)) {
    addDiag(DescriptorDiagCode.UnrecognizedArgSpecCall, node.expression, "Unrecognized arg spec call.");
    return undefined;
  }

  const callee = node.expression.text;
  switch (callee) {
    case "modifier":
      return extractModifierSpec(node, checker, addDiag);
    case "param":
      return extractParamSpec(node, checker, addDiag);
    case "choice":
      return extractChoiceSpec(node, checker, addDiag);
    case "optional":
      return extractOptionalSpec(node, checker, addDiag);
    case "repeated":
      return extractRepeatedSpec(node, checker, addDiag);
    case "conditional":
      return extractConditionalSpec(node, checker, addDiag);
    case "seq":
      return extractSeqSpec(node, checker, addDiag);
    default:
      addDiag(
        DescriptorDiagCode.UnrecognizedArgSpecCall,
        node.expression,
        `Unrecognized arg spec function: \`${callee}\`.`
      );
      return undefined;
  }
}

function extractModifierSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedArgSpec | undefined {
  const args = node.arguments;
  if (args.length < 1 || !ts.isStringLiteral(args[0])) {
    addDiag(
      DescriptorDiagCode.ModifierIdMustBeStringLiteral,
      args[0] ?? node,
      "`modifier()` first argument must be a string literal id."
    );
    return undefined;
  }

  const id = args[0].text;
  const isExistingRef = id.startsWith("modifier.");

  if (args.length < 2 && !isExistingRef) {
    addDiag(
      DescriptorDiagCode.ModifierOptsMustBeObjectLiteral,
      node,
      "`modifier()` requires a second argument with `{ label }` for custom modifiers."
    );
    return undefined;
  }

  if (isExistingRef && args.length < 2) {
    return { kind: "modifier", id, label: "" };
  }

  if (!ts.isObjectLiteralExpression(args[1])) {
    addDiag(
      DescriptorDiagCode.ModifierOptsMustBeObjectLiteral,
      args[1],
      "`modifier()` second argument must be an object literal."
    );
    return undefined;
  }

  let label: string | undefined;
  let icon: string | undefined;

  for (const prop of args[1].properties) {
    const member = configMember(prop, checker, addDiag);
    if (!member) continue;
    const value = member.value;
    if (member.name === "label") {
      if (ts.isStringLiteral(value)) {
        label = value.text;
      } else {
        addDiag(
          DescriptorDiagCode.ModifierLabelMustBeStringLiteral,
          value,
          "`modifier()` label must be a string literal."
        );
      }
    } else if (member.name === "icon") {
      if (ts.isStringLiteral(value)) {
        icon = value.text;
      } else {
        addDiag(
          DescriptorDiagCode.ModifierIconMustBeStringLiteral,
          value,
          "`modifier()` icon must be a string literal."
        );
      }
    }
  }

  if (label === undefined) {
    addDiag(DescriptorDiagCode.ModifierLabelRequired, args[1], "`modifier()` requires a `label` property.");
    return undefined;
  }

  return { kind: "modifier", id, label, icon };
}

function extractParamSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedParam | undefined {
  const args = node.arguments;
  if (args.length < 2 || !ts.isStringLiteral(args[0])) {
    addDiag(
      DescriptorDiagCode.ParamNameMustBeStringLiteral,
      args[0] ?? node,
      "`param()` first argument must be a string literal name."
    );
    return undefined;
  }

  const paramName = args[0].text;

  if (!ts.isObjectLiteralExpression(args[1])) {
    addDiag(
      DescriptorDiagCode.ParamOptsMustBeObjectLiteral,
      args[1],
      "`param()` second argument must be an object literal."
    );
    return undefined;
  }

  let type: string | undefined;
  let typeNode: ts.Expression | undefined;
  let defaultValue: number | string | boolean | null | undefined;
  let hasDefault = false;
  let anonymous = false;

  for (const prop of args[1].properties) {
    const member = configMember(prop, checker, addDiag);
    if (!member) continue;
    const value = member.value;

    if (member.name === "type") {
      if (ts.isStringLiteral(value)) {
        type = value.text;
      } else if (ts.isIdentifier(value)) {
        type = value.text;
        typeNode = value;
      } else {
        addDiag(
          DescriptorDiagCode.ParamTypeMustBeStringLiteral,
          value,
          "Param `type` must be a type name string literal or a type reference."
        );
      }
    } else if (member.name === "default") {
      hasDefault = true;
      defaultValue = extractLiteralValue(value);
      if (defaultValue === undefined && !isNullishLiteral(value)) {
        addDiag(DescriptorDiagCode.ParamDefaultMustBeLiteral, value, "Param `default` must be a literal value.");
      }
    } else if (member.name === "anonymous") {
      if (value.kind === ts.SyntaxKind.TrueKeyword) {
        anonymous = true;
      } else if (value.kind === ts.SyntaxKind.FalseKeyword) {
        anonymous = false;
      } else {
        addDiag(DescriptorDiagCode.ParamAnonymousMustBeBoolean, value, "Param `anonymous` must be a boolean literal.");
      }
    }
  }

  if (type === undefined) {
    addDiag(DescriptorDiagCode.ParamDefinitionMissingType, args[1], "Param definition must have a `type` property.");
    return undefined;
  }

  const result: ExtractedParam = { kind: "param", name: paramName, type, anonymous };
  if (typeNode) {
    result.typeNode = typeNode;
  }
  if (hasDefault) {
    result.defaultValue = defaultValue;
  }
  return result;
}

function extractChoiceSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedArgSpec | undefined {
  const args = node.arguments;
  if (args.length === 0) {
    addDiag(DescriptorDiagCode.ChoiceRequiresArguments, node, "`choice()` requires at least one argument.");
    return undefined;
  }

  let name: string | undefined;
  let startIdx = 0;

  if (ts.isStringLiteral(args[0])) {
    name = args[0].text;
    startIdx = 1;
  }

  const items: ExtractedArgSpec[] = [];
  for (let i = startIdx; i < args.length; i++) {
    const spec = extractArgSpec(args[i], checker, addDiag);
    if (spec) items.push(spec);
  }

  if (items.length === 0) {
    addDiag(DescriptorDiagCode.ChoiceRequiresArguments, node, "`choice()` requires at least one spec argument.");
    return undefined;
  }

  return { kind: "choice", name, items };
}

function extractOptionalSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedArgSpec | undefined {
  if (node.arguments.length !== 1) {
    addDiag(DescriptorDiagCode.OptionalRequiresOneArgument, node, "`optional()` requires exactly one argument.");
    return undefined;
  }

  const item = extractArgSpec(node.arguments[0], checker, addDiag);
  if (!item) return undefined;
  return { kind: "optional", item };
}

function extractRepeatedSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedArgSpec | undefined {
  if (node.arguments.length < 1) {
    addDiag(DescriptorDiagCode.RepeatedRequiresModifier, node, "`repeated()` requires at least one argument.");
    return undefined;
  }

  const item = extractArgSpec(node.arguments[0], checker, addDiag);
  if (!item) return undefined;

  let min: number | undefined;
  let max: number | undefined;

  if (node.arguments.length >= 2) {
    if (!ts.isObjectLiteralExpression(node.arguments[1])) {
      addDiag(
        DescriptorDiagCode.RepeatedOptsMustBeObjectLiteral,
        node.arguments[1],
        "`repeated()` second argument must be an object literal."
      );
      return undefined;
    }
    for (const prop of node.arguments[1].properties) {
      const member = configMember(prop, checker, addDiag);
      if (!member) continue;
      const value = member.value;
      if (member.name === "min") {
        if (ts.isNumericLiteral(value)) {
          min = Number.parseFloat(value.text);
        } else {
          addDiag(
            DescriptorDiagCode.RepeatedBoundMustBeNumericLiteral,
            value,
            "`repeated()` `min` must be a numeric literal."
          );
        }
      } else if (member.name === "max") {
        if (ts.isNumericLiteral(value)) {
          max = Number.parseFloat(value.text);
        } else {
          addDiag(
            DescriptorDiagCode.RepeatedBoundMustBeNumericLiteral,
            value,
            "`repeated()` `max` must be a numeric literal."
          );
        }
      }
    }
  }

  return { kind: "repeated", item, min, max };
}

function extractConditionalSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedArgSpec | undefined {
  if (node.arguments.length < 2) {
    addDiag(
      DescriptorDiagCode.ConditionalRequiresAtLeastTwoArguments,
      node,
      "`conditional()` requires at least two arguments: condition and thenItem."
    );
    return undefined;
  }

  if (!ts.isStringLiteral(node.arguments[0])) {
    addDiag(
      DescriptorDiagCode.ConditionalConditionMustBeStringLiteral,
      node.arguments[0],
      "`conditional()` first argument must be a string literal condition name."
    );
    return undefined;
  }
  const condition = node.arguments[0].text;

  const thenItem = extractArgSpec(node.arguments[1], checker, addDiag);
  if (!thenItem) return undefined;

  let elseItem: ExtractedArgSpec | undefined;
  if (node.arguments.length >= 3) {
    elseItem = extractArgSpec(node.arguments[2], checker, addDiag) ?? undefined;
  }

  return { kind: "conditional", condition, thenItem, elseItem };
}

function extractSeqSpec(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  addDiag: AddDiag
): ExtractedArgSpec | undefined {
  if (node.arguments.length === 0) {
    addDiag(DescriptorDiagCode.SeqRequiresArguments, node, "`seq()` requires at least one argument.");
    return undefined;
  }

  const items: ExtractedArgSpec[] = [];
  for (const a of node.arguments) {
    const spec = extractArgSpec(a, checker, addDiag);
    if (spec) items.push(spec);
  }
  return { kind: "seq", items };
}

function extractReturnType(
  funcNode: ts.FunctionExpression | ts.MethodDeclaration | ts.ArrowFunction,
  isAsync: boolean,
  addDiag: (code: DescriptorDiagCode, node: ts.Node, message: string) => void
): { name: string; node: ts.TypeNode } | undefined {
  const typeNode = funcNode.type;
  if (!typeNode) {
    addDiag(
      DescriptorDiagCode.SensorReturnTypeRequired,
      funcNode,
      "Sensor `onExecute` must have an explicit return type annotation."
    );
    return undefined;
  }

  let effectiveType = typeNode;

  if (isAsync && ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName;
    if (ts.isIdentifier(typeName) && typeName.text === "Promise" && typeNode.typeArguments?.length === 1) {
      effectiveType = typeNode.typeArguments[0];
    }
  }

  const returnTypeName = extractTypeNodeText(effectiveType);
  if (!returnTypeName) {
    addDiag(
      DescriptorDiagCode.SensorReturnTypeRequired,
      typeNode,
      "Sensor `onExecute` return type must be a type name."
    );
    return undefined;
  }

  if (returnTypeName === "void") {
    addDiag(DescriptorDiagCode.SensorReturnTypeMustNotBeVoid, typeNode, "Sensor `onExecute` must not return void.");
    return undefined;
  }

  return { name: returnTypeName, node: effectiveType };
}

function extractTypeNodeText(typeNode: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text;
  }
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) return "string";
  if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (typeNode.kind === ts.SyntaxKind.VoidKeyword) return "void";

  if (ts.isUnionTypeNode(typeNode)) {
    const nonNullTypes = typeNode.types.filter(
      (t) => t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword
    );
    const hasNull = typeNode.types.some(
      (t) => t.kind === ts.SyntaxKind.NullKeyword || t.kind === ts.SyntaxKind.UndefinedKeyword
    );
    if (nonNullTypes.length === 1 && hasNull) {
      const baseName = extractTypeNodeText(nonNullTypes[0]);
      if (baseName) return `${baseName}?`;
    }
  }

  return undefined;
}

function getPropertyName(prop: ts.PropertyAssignment): string | undefined {
  if (ts.isIdentifier(prop.name)) return prop.name.text;
  if (ts.isStringLiteral(prop.name)) return prop.name.text;
  return undefined;
}

function extractLiteralValue(node: ts.Expression): number | string | boolean | null | undefined {
  if (ts.isNumericLiteral(node)) return Number.parseFloat(node.text);
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number.parseFloat(node.operand.text);
  }
  return undefined;
}

function isNullishLiteral(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined");
}
