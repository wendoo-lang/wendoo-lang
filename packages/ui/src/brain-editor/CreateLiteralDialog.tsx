import type { LiteralDisplayFormat } from "@wendoo/core/brain";
import { CoreTypeIds } from "@wendoo/core/runtime";
import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { kStripPopupAttribute } from "./BrainCandidateStrip";
import { type CustomLiteralType, dialogLiteralType, useBrainEditorConfig } from "./BrainEditorContext";
import { DisplayFormatPicker } from "./DisplayFormatPicker";

/** The id the dialog's name field carries, which its own label points at. */
export const kLiteralNameFieldId = "literalDisplayName";

/**
 * Whether the create-literal dialog stands its name field for `literalType`:
 * a type the host supplies a `customLiteralTypes` entry carrying the dialog
 * members for takes one, and the built-in text and number forms and a
 * display-only type take none.
 */
export function literalTypeTakesName(
  literalType: string,
  customLiteralTypes: ReadonlyArray<CustomLiteralType>
): boolean {
  if (literalType === CoreTypeIds.String || literalType === CoreTypeIds.Number) return false;
  return dialogLiteralType(literalType, customLiteralTypes) !== undefined;
}

/**
 * Whether a dialog standing the name field takes a submission holding `name`:
 * a name of nothing but whitespace names nothing, and no literal is created or
 * edited on it.
 */
export function literalNameAccepted(name: string): boolean {
  return name.trim() !== "";
}

/**
 * The word a submission of `name` puts on the literal: `name` with its
 * surrounding whitespace dropped, so " rock " names "rock". A name of nothing
 * but whitespace names nothing and yields `undefined`; call
 * {@link literalNameAccepted} first to keep that case unsubmittable.
 */
export function submittedLiteralName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** What the field naming a literal stands on. */
interface LiteralNameFieldProps {
  /** The name the field holds. */
  value: string;
  /** Called with the field's text as it is typed. */
  onChange: (value: string) => void;
  /** Called when Enter is pressed in the field. */
  onSubmit: () => void;
}

/**
 * The field naming the literal a dialog is creating or editing. It carries
 * {@link kLiteralNameFieldId}, and the name it holds is the word the literal
 * reads by. A dialog standing this field takes no submission while it is empty.
 */
export function LiteralNameField({ value, onChange, onSubmit }: LiteralNameFieldProps) {
  return (
    <div className="grid grid-cols-4 items-center gap-4">
      <label htmlFor={kLiteralNameFieldId} className="text-right text-foreground font-medium">
        Name
      </label>
      <Input
        id={kLiteralNameFieldId}
        data-testid={kLiteralNameFieldId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="col-span-3"
        placeholder="Required"
        autoComplete="off"
      />
    </div>
  );
}

interface CreateLiteralDialogProps {
  isOpen: boolean;
  title: string;
  literalType: string;
  onOpenChange: (open: boolean) => void;
  /**
   * Called as the dialog closes, before the keyboard is handed back to the
   * element that held it when the dialog opened. Calling `preventDefault` on the
   * event leaves that hand-back to the caller.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /**
   * Called with the value the dialog names, the display format a number literal
   * takes, and the word the literal reads by -- `undefined` for a type standing
   * no name field.
   */
  onSubmit: (value: unknown, displayFormat?: LiteralDisplayFormat, displayName?: string) => void;
  /**
   * The value an existing literal of `literalType` carries, which the fields of
   * the matching `customLiteralTypes` entry open seeded with. Left out, the
   * dialog opens on empty fields.
   */
  initialValue?: unknown;
  /**
   * The word the name field opens holding: an existing literal's own, or the
   * default offered for a new one. Left out, that field opens empty, which a
   * type standing the field takes no submission on.
   */
  initialName?: string;
}

/**
 * Dialog that names the value of a literal tile. Renders inputs appropriate for
 * the given `literalType`: built-in string/number forms, or fields from the
 * matching `customLiteralTypes` entry in {@link BrainEditorConfig} carrying the
 * dialog members; for a display-only type it renders no fields and takes no
 * submission. Its content
 * carries {@link kStripPopupAttribute}, so the keyboard landing in it counts as
 * staying in the candidate strip the literal was minted from.
 */
export function CreateLiteralDialog({
  isOpen,
  title,
  literalType,
  onOpenChange,
  onCloseAutoFocus,
  onSubmit,
  initialValue,
  initialName,
}: CreateLiteralDialogProps) {
  const { customLiteralTypes } = useBrainEditorConfig();
  const customType = dialogLiteralType(literalType, customLiteralTypes);
  const [stringValue, setStringValue] = useState("");
  const [numberValue, setNumberValue] = useState("");
  const [displayFormat, setDisplayFormat] = useState<LiteralDisplayFormat>("default");
  const [customState, setCustomState] = useState<Record<string, string>>(() =>
    customType && initialValue !== undefined ? customType.toInputState(initialValue) : {}
  );
  const [displayName, setDisplayName] = useState(initialName ?? "");
  const isEditing = initialValue !== undefined;
  const takesName = literalTypeTakesName(literalType, customLiteralTypes);

  const handleCustomStateChange = (key: string, value: string) => {
    setCustomState((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    if (!isValid()) return;
    let value: unknown;

    if (literalType === CoreTypeIds.String) {
      value = stringValue;
    } else if (literalType === CoreTypeIds.Number) {
      const num = Number.parseFloat(numberValue);
      if (Number.isNaN(num)) return;
      value = num;
    } else if (customType) {
      if (!customType.isValid(customState)) return;
      value = customType.parseValue(customState);
    } else {
      return;
    }

    const fmt = literalType === CoreTypeIds.Number && displayFormat !== "default" ? displayFormat : undefined;
    onSubmit(value, fmt, takesName ? submittedLiteralName(displayName) : undefined);
    resetForm();
  };

  const resetForm = () => {
    setStringValue("");
    setNumberValue("");
    setDisplayFormat("default");
    setCustomState({});
    setDisplayName("");
  };

  const handleCancel = () => {
    resetForm();
    onOpenChange(false);
  };

  const isValid = () => {
    if (takesName && !literalNameAccepted(displayName)) return false;
    if (literalType === CoreTypeIds.String) {
      return true;
    } else if (literalType === CoreTypeIds.Number) {
      return numberValue !== "" && !Number.isNaN(Number.parseFloat(numberValue));
    } else if (customType) {
      return customType.isValid(customState);
    }
    return false;
  };

  const renderInputFields = () => {
    if (literalType === CoreTypeIds.String) {
      return (
        <div className="grid grid-cols-4 items-center gap-4">
          <label htmlFor="stringValue" className="text-right text-foreground font-medium">
            Value
          </label>
          <Input
            id="stringValue"
            type="text"
            value={stringValue}
            onChange={(e) => setStringValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
            className="col-span-3"
            placeholder="Enter string value"
            autoComplete="off"
            autoFocus
          />
        </div>
      );
    } else if (literalType === CoreTypeIds.Number) {
      return (
        <>
          <div className="grid grid-cols-4 items-center gap-4">
            <label htmlFor="numberValue" className="text-right text-foreground font-medium">
              Value
            </label>
            <Input
              id="numberValue"
              type="number"
              value={numberValue}
              onChange={(e) => setNumberValue(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="col-span-3"
              placeholder="0"
              autoComplete="off"
              autoFocus
            />
          </div>
          <DisplayFormatPicker value={displayFormat} onChange={setDisplayFormat} />
        </>
      );
    } else if (customType) {
      return customType.renderInputFields(customState, handleCustomStateChange, handleSubmit);
    }
    return null;
  };

  const getDescription = () => {
    if (literalType === CoreTypeIds.String) {
      return "Enter a string value.";
    } else if (literalType === CoreTypeIds.Number) {
      return "Enter a numeric value.";
    } else if (customType) {
      return customType.description;
    }
    return "Enter a value for the literal.";
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-106.25 bg-popover border-2 border-border rounded-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
        {...{ [kStripPopupAttribute]: "" }}
      >
        <DialogHeader className="border-b border-border pb-4">
          <DialogTitle className="text-foreground font-semibold">{title}</DialogTitle>
          <DialogDescription className={customType ? "sr-only" : "text-muted-foreground"}>
            {getDescription()}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {renderInputFields()}
          {takesName && <LiteralNameField value={displayName} onChange={setDisplayName} onSubmit={handleSubmit} />}
        </div>
        <DialogFooter className="gap-2 pt-4 border-t border-border">
          <Button
            variant="cancel"
            className="rounded-lg"
            onClick={handleCancel}
            aria-label={isEditing ? "Cancel editing literal" : "Cancel creating literal"}
          >
            Cancel
          </Button>
          <Button
            className="rounded-lg"
            onClick={handleSubmit}
            disabled={!isValid()}
            aria-label={isEditing ? "Save literal value" : "Create literal value"}
          >
            {isEditing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
