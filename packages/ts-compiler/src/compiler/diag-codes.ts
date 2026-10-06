/**
 * Diagnostic codes for the TypeScript user-tile compiler.
 *
 * Each diagnostic has a unique numeric code.
 * Codes are organized by compiler phase:
 * - 1000-1099: Validator diagnostics (forbidden syntax)
 * - 2000-2099: Descriptor extraction diagnostics
 * - 3000-3999: Lowering diagnostics
 * - 4000-4099: Emit diagnostics
 * - 5000-5099: Compile orchestration diagnostics
 */

/**
 * Validator diagnostic codes (1000-1099)
 *
 * Emitted when the AST contains syntax constructs that are not
 * supported by the user-tile runtime.
 */
export enum ValidatorDiagCode {
  /** Class expressions (inline) are not supported */
  ClassExpressionsNotSupported = 1000,
  /** Reserved legacy validator code for enum rejection */
  EnumsNotSupported = 1001,
  /** Reserved legacy validator code for validator-level for...in rejection */
  ForInNotSupported = 1002,
  /** with statements are not supported */
  WithNotSupported = 1003,
  /** switch statements are not supported */
  SwitchNotSupported = 1004,
  /** Generator functions (yield) are not supported */
  GeneratorsNotSupported = 1005,
  /** Computed property names (non-literal) are not supported */
  ComputedPropertyNamesNotSupported = 1006,
  /** debugger statements are not supported */
  DebuggerNotSupported = 1007,
  /** Labeled statements are not supported */
  LabeledStatementsNotSupported = 1008,
  /** delete expressions are not supported */
  DeleteNotSupported = 1009,
  /** Regular expression literals are not supported */
  RegularExpressionsNotSupported = 1010,
  /** var declarations are not allowed; use let or const */
  VarNotAllowed = 1011,
  /** Dynamic import() calls are not supported */
  DynamicImportNotSupported = 1012,
  /** Reference to a forbidden global identifier */
  ForbiddenGlobalAccess = 1013,
  /** Decorators are not supported */
  DecoratorsNotSupported = 1014,
  /** Class declaration must have a name */
  ClassMustBeNamed = 1015,
  /** Class inheritance (extends) is not supported */
  ClassInheritanceNotSupported = 1016,
  /** Static class members are not supported */
  StaticMembersNotSupported = 1017,
  /** Private fields (#name) are not supported */
  PrivateFieldsNotSupported = 1018,
  /** Class getters/setters are not supported */
  ClassGettersSettersNotSupported = 1019,
  /** Reference to an unsupported built-in type */
  UnsupportedTypeReference = 1020,
}

/**
 * Descriptor extraction diagnostic codes (2000-2099)
 *
 * Emitted when the default export does not conform to the
 * expected Sensor({...}) or Actuator({...}) structure.
 */
export enum DescriptorDiagCode {
  /** No default export found; expected Sensor({...}) or Actuator({...}) */
  MissingDefaultExport = 2000,
  /** Default export is not a call to Sensor or Actuator */
  InvalidDefaultExport = 2001,
  /** Sensor() or Actuator() called with wrong number of arguments */
  InvalidCalleeArgumentCount = 2002,
  /** Sensor() or Actuator() argument is not an object literal */
  CalleeArgumentNotObjectLiteral = 2003,
  /** name property value is not a string literal */
  NameMustBeStringLiteral = 2004,
  /** output property is only valid for sensors */
  OutputOnlyValidForSensors = 2005,
  /** output property value is not a string literal */
  OutputMustBeStringLiteral = 2006,
  /** onExecute property is not a function */
  OnExecuteMustBeFunction = 2007,
  /** onPageEntered property is not a function */
  OnPageEnteredMustBeFunction = 2008,
  /** Required name property is missing */
  NamePropertyRequired = 2009,
  /** Required output property is missing for sensors */
  OutputPropertyRequired = 2010,
  /** Required onExecute method is missing */
  OnExecuteRequired = 2011,
  /** params value is not an object literal */
  ParamsMustBeObjectLiteral = 2012,
  /** Param entry does not use property assignment syntax */
  ParamEntryMustUsePropertySyntax = 2013,
  /** Param key is not an identifier or string literal */
  ParamNameMustBeIdentifier = 2014,
  /** Param definition is not an object literal */
  ParamDefinitionMustBeObjectLiteral = 2015,
  /** Param type value is not a string literal */
  ParamTypeMustBeStringLiteral = 2016,
  /** Param default value is not a literal */
  ParamDefaultMustBeLiteral = 2017,
  /** Param anonymous value is not a boolean literal */
  ParamAnonymousMustBeBoolean = 2018,
  /** Param required value is not a boolean literal */
  ParamRequiredMustBeBoolean = 2025,
  /** Param definition is missing the required type property */
  ParamDefinitionMissingType = 2019,
  /** label property value is not a string literal */
  LabelMustBeStringLiteral = 2020,
  /** icon property value is not a string literal */
  IconMustBeStringLiteral = 2021,
  /** docs property value is not a string literal */
  DocsMustBeStringLiteral = 2022,
  /** tags property value is not an array literal */
  TagsMustBeArrayLiteral = 2023,
  /** tags array element is not a string literal */
  TagElementMustBeStringLiteral = 2024,
  /** id property value is not a string literal */
  IdMustBeStringLiteral = 2026,

  /** args value is not an array literal */
  ArgsMustBeArrayLiteral = 2030,
  /** Unrecognized arg spec call expression */
  UnrecognizedArgSpecCall = 2031,
  /** modifier() first argument must be a string literal */
  ModifierIdMustBeStringLiteral = 2032,
  /** modifier() second argument must be an object literal */
  ModifierOptsMustBeObjectLiteral = 2033,
  /** modifier() label property must be a string literal */
  ModifierLabelMustBeStringLiteral = 2034,
  /** modifier() missing required label property */
  ModifierLabelRequired = 2035,
  /** param() first argument must be a string literal */
  ParamNameMustBeStringLiteral = 2036,
  /** param() second argument must be an object literal */
  ParamOptsMustBeObjectLiteral = 2037,
  /** choice() requires at least one argument */
  ChoiceRequiresArguments = 2038,
  /** optional() requires exactly one argument */
  OptionalRequiresOneArgument = 2039,
  /** repeated() first argument must be a modifier spec */
  RepeatedRequiresModifier = 2040,
  /** conditional() requires at least condition and thenItem */
  ConditionalRequiresAtLeastTwoArguments = 2041,
  /** conditional() condition must be a string literal */
  ConditionalConditionMustBeStringLiteral = 2043,
  /** Sensor onExecute must have a return type annotation */
  SensorReturnTypeRequired = 2044,
  /** Sensor onExecute must not return void */
  SensorReturnTypeMustNotBeVoid = 2045,
  /** modifier() icon property must be a string literal */
  ModifierIconMustBeStringLiteral = 2046,
  /** Arg spec must be a call expression */
  ArgSpecMustBeCallExpression = 2047,
  /** repeated() second argument must be an object literal */
  RepeatedOptsMustBeObjectLiteral = 2048,
  /** repeated() min/max must be numeric literals */
  RepeatedBoundMustBeNumericLiteral = 2049,
  /** seq() requires at least one argument */
  SeqRequiresArguments = 2050,
  /** onPageExited property is not a function */
  OnPageExitedMustBeFunction = 2051,
  /** a config's `consumesWhenResult` is not a type name string literal or type reference identifier */
  ConsumesWhenResultMustBeNameOrRef = 2052,
  /** language property value is not an object literal */
  LanguageMustBeObjectLiteral = 2053,
  /** outputs property value is not an array literal */
  OutputsMustBeArrayLiteral = 2054,
  /** an outputs array element is not an object literal */
  OutputEntryMustBeObjectLiteral = 2055,
  /** an output's name is not a string literal */
  OutputNameMustBeStringLiteral = 2056,
  /** an output entry is missing the required name property */
  OutputNameRequired = 2057,
  /** an output's type is not a string literal */
  OutputTypeMustBeStringLiteral = 2058,
  /** an output entry is missing the required type property */
  OutputTypeRequired = 2059,
  /** an output's label is not a string literal */
  OutputLabelMustBeStringLiteral = 2060,
  /** an output's icon is not a string literal */
  OutputIconMustBeStringLiteral = 2061,
  /** an output's docs is not a string literal */
  OutputDocsMustBeStringLiteral = 2062,
  /** an output's tags property is not an array literal */
  OutputTagsMustBeArrayLiteral = 2063,
  /** an output's tags array element is not a string literal */
  OutputTagElementMustBeStringLiteral = 2064,
  /** two outputs on the same sensor share a name (output names must be unique per sensor) */
  DuplicateOutputName = 2065,
  /** a Conversion config is missing the required from or to member */
  ConversionTypeRequired = 2066,
  /** a Conversion config's cost is missing or not a positive numeric literal */
  ConversionCostMustBePositiveNumber = 2067,
  /** a Conversion config is missing the required convert member */
  ConversionConvertRequired = 2068,
  /** a Conversion config's convert member is not a function */
  ConversionConvertMustBeFunction = 2069,
  /** a Conversion config's convert function does not take exactly one parameter */
  ConversionConvertParamCount = 2070,
  /** a Conversion config's convert function is async (conversions are synchronous) */
  ConversionConvertMustBeSync = 2071,
  /** a sensor config's returnType is not a type name string literal or type reference identifier */
  ReturnTypeMustBeNameOrRef = 2072,
  /** a config object uses spread; members must be written inline */
  ConfigMemberNotInline = 2073,
  /** a shorthand config member does not resolve to a declared value */
  ShorthandMemberUnresolvable = 2074,
  /** a sensor config's `inline` value is not a boolean literal */
  InlineMustBeBoolean = 2075,
  /** a sensor config's `presenceGated` value is not a boolean literal */
  PresenceGatedMustBeBoolean = 2076,
  /** a sensor config declares `inline: true` together with a non-empty `args` (inline sensors take no arguments) */
  InlineSensorTakesNoArgs = 2077,
  /** a config's `language.form` is not a string literal */
  LanguageFormMustBeStringLiteral = 2078,
  /** a config's `language.frame` is not one of the frame name literals */
  LanguageFrameMustBeFrameName = 2079,
  /** a config's `language.bare` is not a string literal */
  LanguageBareMustBeStringLiteral = 2080,
  /** an output's writableResult is not a boolean literal */
  OutputWritableResultMustBeBoolean = 2081,
}

/**
 * Lowering diagnostic codes (3000-3999)
 *
 * Emitted during AST-to-IR lowering when a construct cannot be
 * translated to the user-tile instruction set.
 */
export enum LoweringDiagCode {
  /** Helper function declaration has no body */
  FunctionHasNoBody = 3000,
  /** onExecute function has no body */
  OnExecuteHasNoBody = 3001,
  /** onPageEntered function has no body */
  OnPageEnteredHasNoBody = 3002,
  /** Statement kind is not supported in user-tile programs */
  UnsupportedStatement = 3003,
  /** Expression kind is not supported in user-tile programs */
  UnsupportedExpression = 3004,
  /** Variable binding pattern is not supported */
  UnsupportedBindingPattern = 3005,
  /** Function call form is not supported */
  UnsupportedFunctionCall = 3006,
  /** Reference to an undeclared variable */
  UndefinedVariable = 3010,
  /** break used outside of a loop */
  BreakOutsideLoop = 3011,
  /** continue used outside of a loop */
  ContinueOutsideLoop = 3012,
  /** Destructuring declaration is missing an initializer */
  DestructuringMissingInitializer = 3020,
  /** Free slot -- available for reuse. */
  Unused3021 = 3021,
  /** Destructuring in onExecute parameter position is not supported */
  DestructuringInOnExecuteNotSupported = 3024,
  /** Rest element must be the last element in an array destructuring pattern */
  RestElementMustBeLast = 3025,
  /** for...of is only supported on list-typed values */
  ForOfOnNonListType = 3030,
  /** for...of requires a variable declaration as its initializer */
  ForOfRequiresVariableDeclaration = 3031,
  /** for...of binding must be a single identifier */
  ForOfRequiresSingleIdentifier = 3032,
  /** Cannot resolve an operator needed to implement for...of iteration */
  ForOfCannotResolveOperator = 3033,
  /** for...in is only supported on list, map, and registered struct values */
  ForInOnUnsupportedType = 3034,
  /** for...in requires a variable declaration as its initializer */
  ForInRequiresVariableDeclaration = 3035,
  /** for...in binding must be a single identifier */
  ForInRequiresSingleIdentifier = 3036,
  /** Cannot resolve an operator needed to implement for...in iteration */
  ForInCannotResolveOperator = 3037,
  /** Binary operator is not supported */
  UnsupportedOperator = 3040,
  /** Cannot determine operand types for binary operator */
  CannotDetermineTypesForBinaryOp = 3041,
  /** No operator overload found for the given operand types */
  NoOperatorOverload = 3042,
  /** Prefix operator is not supported */
  UnsupportedPrefixOperator = 3043,
  /** Compound assignment operator is not supported */
  UnsupportedCompoundAssignOperator = 3044,
  /** Cannot determine operand types for compound assignment */
  CannotDetermineTypesForCompoundAssign = 3045,
  /** Increment or decrement target is not a variable */
  IncrDecrTargetNotVariable = 3046,
  /** Assignment target is not a simple variable */
  AssignmentTargetNotVariable = 3047,
  /** Cannot determine the type of the ! operand */
  CannotDetermineTypeForNotOperand = 3048,
  /** typeof comparison value is not a supported type string */
  UnsupportedTypeofComparison = 3049,
  /** Cannot convert an expression to string because its type is unknown */
  CannotConvertToString = 3050,
  /** No registered conversion from the given type to string */
  NoConversionToString = 3051,
  /** No operator overload for string concatenation */
  NoOverloadForStringConcat = 3052,
  /** Both implicit conversion directions are viable for a binary operator */
  AmbiguousImplicitBinaryConversion = 3053,
  /** No valid single-step conversion exists for a target-typed boundary */
  NoConversionToTargetType = 3054,
  /** Property access on a struct references a field that does not exist */
  PropertyNotOnStruct = 3060,
  /** Property access form is not supported */
  UnsupportedPropertyAccess = 3061,
  /** Method called on a struct is not registered */
  UnknownStructMethod = 3062,
  /** RHS struct type is not structurally compatible with LHS type */
  StructurallyIncompatibleTypes = 3063,
  /** Cannot determine the type expected for an object literal */
  CannotDetermineTypeForObjectLiteral = 3070,
  /** Cannot instantiate a native-backed struct type with an object literal */
  CannotInstantiateNativeBackedStruct = 3071,
  /** Object literal type does not resolve to a known struct or map type */
  ObjectLiteralTypeUnresolvable = 3072,
  /** Object literal property is not a simple property assignment */
  UnsupportedPropertyInObjectLiteral = 3073,
  /** Object literal property name is not an identifier or string literal */
  UnsupportedPropertyNameInObjectLiteral = 3074,
  /** Map literal property is not a simple property assignment */
  UnsupportedPropertyInMapLiteral = 3075,
  /** Map literal property name is not an identifier or string literal */
  UnsupportedPropertyNameInMapLiteral = 3076,
  /** Spread source type cannot be resolved to a type with known properties */
  SpreadSourceUnresolvable = 3077,
  /** Element access (bracket index) is only supported on list types */
  ElementAccessOnNonListType = 3080,
  /** Element access assignment is only supported on list types */
  ElementAccessAssignOnNonListType = 3081,
  /** await is used outside of an async host function call */
  AwaitOnNonAsyncHostCall = 3082,
  /** Cannot determine the element type for an array literal */
  CannotDetermineListType = 3083,
  /** Array method is recognized but not supported in user-tile programs */
  ArrayMethodNotSupported = 3090,
  /** Array method is not recognized */
  UnsupportedArrayMethod = 3091,
  /** .push() called with wrong number of arguments */
  PushRequiresOneArg = 3092,
  /** .pop() called with arguments */
  PopTakesNoArgs = 3093,
  /** .shift() called with arguments */
  ShiftTakesNoArgs = 3094,
  /** .unshift() called with wrong number of arguments */
  UnshiftRequiresOneArg = 3095,
  /** .splice() called without required start argument */
  SpliceRequiresAtLeastOneArg = 3096,
  /** .sort() called without a comparator function argument */
  SortRequiresComparatorFn = 3097,
  /** .indexOf() called with wrong number of arguments */
  IndexOfRequiresOneArg = 3098,
  /** .filter() called with wrong number of arguments */
  FilterRequiresOneArg = 3099,
  /** .map() called with wrong number of arguments */
  MapRequiresOneArg = 3100,
  /** Cannot determine result list type for .map() */
  CannotDetermineMapResultListType = 3101,
  /** .forEach() called with wrong number of arguments */
  ForEachRequiresOneArg = 3102,
  /** .includes() called with wrong number of arguments */
  IncludesRequiresOneArg = 3103,
  /** .some() called with wrong number of arguments */
  SomeRequiresOneArg = 3104,
  /** .every() called with wrong number of arguments */
  EveryRequiresOneArg = 3105,
  /** .find() called with wrong number of arguments */
  FindRequiresOneArg = 3106,
  /** .join() called with too many arguments */
  JoinTakesAtMostOneArg = 3107,
  /** .reverse() called with arguments */
  ReverseTakesNoArgs = 3108,
  /** .slice() called with too many arguments */
  SliceTakesAtMostTwoArgs = 3109,
  /** Cannot resolve an operator needed to implement an array method */
  CannotResolveOperatorForArrayMethod = 3110,
  /** Cannot convert a list element to string for .join() */
  CannotConvertListElementToString = 3111,
  /** .lastIndexOf() called with wrong number of arguments */
  LastIndexOfRequiresOneArg = 3112,
  /** .findIndex() called with wrong number of arguments */
  FindIndexRequiresOneArg = 3113,
  /** .reduce() called with wrong number of arguments */
  ReduceRequiresOneOrTwoArgs = 3114,
  /** .toString() called with arguments */
  ArrayToStringTakesNoArgs = 3115,
  /** Array.from() called with wrong number of arguments */
  ArrayFromRequiresOneOrTwoArgs = 3116,
  /** Array.from() called on a non-list type */
  ArrayFromNonListSource = 3117,
  /** Cannot determine result list type for Array.from() */
  CannotDetermineArrayFromResultListType = 3118,
  /** Math method is not supported */
  UnsupportedMathMethod = 3120,
  /** Math.max()/Math.min() called with wrong number of arguments */
  MathMinMaxRequiresTwoArgs = 3121,
  /** Math method called with wrong number of arguments */
  MathMethodWrongArgCount = 3122,
  /** String method is not supported */
  UnsupportedStringMethod = 3130,
  /** String method called with wrong number of arguments */
  StringMethodWrongArgCount = 3131,
  /** Buffer constructor or method is not supported */
  UnsupportedBufferMethod = 3135,
  /** Buffer constructor or method called with wrong number of arguments */
  BufferMethodWrongArgCount = 3136,
  /** Free slot -- available for reuse. */
  Unused3140 = 3140,
  /** Cannot resolve the type of a class field */
  UnresolvableClassFieldType = 3141,
  /** `this` keyword used outside of a class constructor or method */
  ThisOutsideClassContext = 3142,
  /** `new` expression target is not a known class */
  NewExpressionUnknownClass = 3143,
  /** `new` expression target is not an identifier */
  NewExpressionNotIdentifier = 3144,
  /** Enum objects cannot be used as runtime values; only direct member access is supported */
  EnumObjectUsageNotSupported = 3145,
  /** Cannot resolve the list type for a rest parameter */
  CannotResolveRestParamListType = 3146,
  /** Spread argument must be the last argument in a function call */
  SpreadMustBeLastArgument = 3147,
  /** Spread in a function call requires the target to have a rest parameter */
  SpreadRequiresRestTarget = 3148,
  /** Cannot resolve the type of an interface field */
  UnresolvableInterfaceFieldType = 3150,
  /** Interface has unsupported members (index signatures, call signatures, etc.) */
  UnsupportedInterfaceMember = 3151,
  /** Free slot -- available for reuse. */
  Unused3152 = 3152,
  /** User interface name collides with an ambient (runtime-registered) type */
  InterfaceCollidesWithAmbientType = 3153,
  /** Free slot -- available for reuse. */
  Unused3154 = 3154,
  /** User type alias name collides with an ambient (runtime-registered) type */
  TypeAliasCollidesWithAmbientType = 3155,
  /** Class objects cannot be used as runtime values; only property access and `new` are supported */
  ClassObjectUsageNotSupported = 3156,
  /** No static member with this name exists on the class */
  NoSuchStaticMember = 3157,
  /** Compound assignment or increment/decrement requires both a getter and a setter */
  CompoundAssignRequiresGetterAndSetter = 3158,
  /** Computed property names are not supported in class members */
  ComputedClassMemberNameNotSupported = 3159,
  /** Map method called with wrong number of arguments */
  MapMethodWrongArgCount = 3160,
  /** Map method is not recognized */
  UnsupportedMapMethod = 3161,
  /** new Map() argument must be an array literal of [key, value] tuples */
  MapConstructorBadArgument = 3162,
  /** new Map() was called with too many arguments */
  MapConstructorTooManyArgs = 3163,
  /** Cannot determine map type for new Map() expression */
  MapConstructorUnresolvableType = 3164,
  /** instanceof RHS must be a class name known at compile time */
  InstanceofRhsNotClass = 3170,
  /** Assignment to a read-only struct field */
  ReadOnlyFieldAssignment = 3171,
  /** onPageExited function has no body */
  OnPageExitedHasNoBody = 3172,
  /** Async host call lowered into a body that cannot suspend (sync onExecute, page hook, or module initializer) */
  AsyncHostCallInNonSuspendableContext = 3173,
  /** A method (e.g. `.then`/`.catch`) is called on an async result */
  UnsupportedAsyncResultMethod = 3174,
  /** An async action's result is discarded without `await` (warning) */
  UnawaitedAsyncCall = 3175,

  /** A `System({...})` config `name` is missing or not a string literal */
  SystemNameNotStringLiteral = 3180,
  /** A `System({...})` config `state` is missing or not an object literal */
  SystemStateNotObject = 3181,
  /** A `System({...})` `init` or `think` member is not a method or inline function */
  SystemLifecycleNotFunction = 3182,
  /** A `System({...})` config member (other than name/state/init/think) is not a method */
  SystemMemberNotMethod = 3183,
  /** A `System({...})` `state` shape cannot be lowered to a struct of VM-representable fields */
  SystemStateUnresolvable = 3184,
  /** A `const X = System({...})` binding's declaration symbol cannot be resolved */
  SystemBindingUnresolvable = 3185,
  /** A System method reference is read as a value; a System method must be called */
  SystemMethodUsedAsValue = 3186,

  /** `setOutput(ctx, name, value)` was not called with exactly three arguments */
  SetOutputWrongArgCount = 3187,
  /** `setOutput`'s name argument is not a string literal */
  SetOutputNameNotStringLiteral = 3188,
  /** `setOutput` names an output not declared in the enclosing sensor's `outputs` */
  SetOutputUnknownOutput = 3189,
  /** `setOutput` is used outside a sensor `onExecute` (no outputs are in scope) */
  SetOutputOutsideSensor = 3190,
  /** A declared sensor output's type name does not resolve to a known type */
  OutputTypeUnresolvable = 3191,
  /** A `setOutput` value's type does not match (and is not convertible to) the output's declared type */
  SetOutputValueTypeMismatch = 3192,
  /**
   * A System body references a top-level binding of its defining module that is
   * neither a `const` value nor a `function` (for example a module-level `let`
   * or a class); only `const` values and `function` declarations can be used
   * across the module boundary.
   */
  SystemModuleReferenceNotCarryable = 3193,

  /**
   * `!` applied to a maybe-absent number, string, or boolean; absence must be
   * tested with an explicit `=== undefined` comparison.
   */
  NotOnNullablePrimitive = 3194,

  /** A `StructType({...})` config `name` is missing or not a string literal */
  StructTypeNameNotStringLiteral = 3195,
  /** A `StructType({...})` config member is malformed: `fields` missing, empty, or not `name: type` entries, or `accessors`/`variables` not boolean literals */
  StructTypeMemberInvalid = 3196,
  /** A `StructType({...})` field's type does not name a known type */
  StructTypeFieldTypeUnresolvable = 3197,
  /** Two `StructType({...})` fields share a name */
  StructTypeDuplicateField = 3198,
  /** A `StructType(...)` call's config argument is not a single inline object literal */
  StructTypeConfigNotObjectLiteral = 3199,
  /** A `StructType({...})` field contains its own struct type, directly or through other struct fields */
  StructTypeRecursiveField = 3200,
}

/**
 * Emit diagnostic codes (4000-4099)
 *
 * Emitted during bytecode emission when a referenced function
 * cannot be resolved in the program's function table.
 */
export enum EmitDiagCode {
  /** Host function name does not resolve to a registered function */
  CannotResolveHostFunction = 4000,
  /** User function name does not resolve in the function table */
  CannotResolveFunction = 4001,
  /** Closure function name does not resolve in the function table */
  CannotResolveClosureFunction = 4002,
}

/**
 * Compile orchestration diagnostic codes (5000-5099)
 *
 * Emitted by the top-level compile driver for errors that occur
 * outside of any specific compiler phase.
 */
export enum CompileDiagCode {
  /** Internal error: compiled source file could not be located */
  SourceFileNotFound = 5000,
  /** The sensor output type name is not registered in the type registry */
  UnknownOutputType = 5001,
  /** Diagnostic produced by TypeScript's own type-checker (pre-emit phase) */
  TypeScriptError = 5002,
  /** Helper module contains top-level variables (not yet supported) */
  HelperModuleHasVariables = 5003,
  /** Two imported modules export the same symbol name */
  DuplicateImportedSymbol = 5004,
  /** User-authored enum declaration is invalid or unsupported */
  InvalidEnumDeclaration = 5005,
  /** A metadata file (icon or docs) referenced by a tile config was not found */
  MetadataFileNotFound = 5006,
  /** A shared `parameter.` id is declared with a type that conflicts with an earlier declaration or a registered tile */
  SharedParameterTypeConflict = 5007,
  /** A bare shared `modifier.` reference names a modifier that is neither declared with a label nor already registered */
  UnregisteredModifierReference = 5008,
  /** A shared `parameter.` id is declared with a type name that does not resolve, so its shared tile cannot be materialized */
  SharedParameterUnresolvedType = 5009,
  /** A Conversion's `from` or `to` does not name a known type (unresolvable name or invalid type token) */
  ConversionTypeUnresolved = 5010,
  /** A Conversion declares a `(from, to)` pair that another registration already holds */
  DuplicateConversionPair = 5011,
  /** A `returnType`, output `type`, param `type`, or `consumesWhenResult` reference does not name a known type */
  UnresolvedTypeReference = 5012,
  /** A Conversion's `from` and `to` name the same type */
  ConversionSameType = 5013,
  /** Two declarations carry the same stable `id` */
  DuplicateActionId = 5014,
  /** An action reads the WHEN result (`ctx.getWhenResult()`) but does not declare `consumesWhenResult` (warning) */
  WhenResultReadWithoutDeclaration = 5015,
  /** `consumesWhenResult` resolves to the top type (`any`), which no concrete WHEN result is exactly-or-convertible to, so the tile could never be offered */
  ConsumesWhenResultIsAny = 5016,
  /** A param `type` name does not resolve to a registered type, so the tile's parameter tiles cannot be built */
  ParameterUnresolvedType = 5017,
  /** A shared `modifier.` id is declared with a label that conflicts with an earlier declaration or a registered tile */
  SharedModifierLabelConflict = 5018,
  /** An `@lib/<owner>/<repo>/...` import names a module inside an extension; only the entry surface `@lib/<owner>/<repo>` is importable */
  ExtensionDeepImport = 5019,
  /** The entry module exports one declaration under two or more names; a declaration is published under exactly one name */
  MultiplePublishedNames = 5020,
  /** A published type or tile surface references a name-keyed type that is not published by its declaring project */
  UnpublishedTypeReference = 5021,
  /** A declaration in a read-only extension omits the required stable `id`; the compiler cannot mint one because the extension source is regenerated on load and never saved */
  ExtensionDeclarationMissingId = 5022,
  /** A module this file imports, directly or transitively, has compile errors, so this file cannot compile */
  ImportedFileHasErrors = 5023,
}

/**
 * Union of all TypeScript compiler diagnostic codes.
 */
/** Union of every diagnostic code emitted by the user-tile compiler. */
export type TsDiagCode = ValidatorDiagCode | DescriptorDiagCode | LoweringDiagCode | EmitDiagCode | CompileDiagCode;
