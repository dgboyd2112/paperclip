import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type CopyTextSource =
  | { text: string; getText?: never }
  | { text?: never; getText: () => string };

type CopyTextProps = CopyTextSource & {
  /** What to display. Defaults to `text`. */
  children?: React.ReactNode;
  containerClassName?: string;
  className?: string;
  ariaLabel?: string;
  title?: string;
  /** Tooltip message shown after copying. Default: "Copied!" */
  copiedLabel?: string;
  disabled?: boolean;
};

export function CopyText({
  text,
  getText,
  children,
  containerClassName,
  className,
  ariaLabel,
  title,
  copiedLabel = "Copied!",
  disabled,
}: CopyTextProps) {
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState(copiedLabel);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = useCallback(async () => {
    const value = getText ? getText() : (text ?? "");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback for non-secure contexts (e.g. HTTP on non-localhost)
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          const success = document.execCommand("copy");
          if (!success) throw new Error("execCommand copy failed");
        } finally {
          document.body.removeChild(textarea);
        }
      }
      setLabel(copiedLabel);
    } catch {
      setLabel("Copy failed");
    }
    clearTimeout(timerRef.current);
    setVisible(true);
    timerRef.current = setTimeout(() => setVisible(false), 1500);
  }, [copiedLabel, getText, text]);

  return (
    <span className={cn("relative inline-flex", containerClassName)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        className={cn(
          "cursor-copy hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-current",
          className,
        )}
        onClick={handleClick}
      >
        {children ?? text}
      </button>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 rounded-md bg-foreground text-background px-2 py-1 text-xs whitespace-nowrap transition-opacity duration-300",
          visible ? "opacity-100" : "opacity-0",
        )}
      >
        {label}
      </span>
    </span>
  );
}
