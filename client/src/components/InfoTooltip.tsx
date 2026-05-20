import {
    useEffect,
    useRef,
    useState,
    type FocusEvent as ReactFocusEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";

type InfoTooltipProps = {
    content: string;
    ariaLabel: string;
    describedById: string;
    children: ReactNode;
    hoverDelayMs?: number;
};

export const InfoTooltip = ({
    content,
    ariaLabel,
    describedById,
    children,
    hoverDelayMs = 100,
}: InfoTooltipProps) => {
    const [mouseHovering, setMouseHovering] = useState(false);
    const [keyboardFocused, setKeyboardFocused] = useState(false);
    const [touchOpen, setTouchOpen] = useState(false);
    const [dismissedUntilBlur, setDismissedUntilBlur] = useState(false);
    const openTimerRef = useRef<number | null>(null);
    const triggerRef = useRef<HTMLSpanElement | null>(null);
    const open = mouseHovering || touchOpen || (keyboardFocused && !dismissedUntilBlur);

    const clearOpenTimer = (): void => {
        if (openTimerRef.current === null) return;
        window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
    };

    const handlePointerEnter = (event: ReactPointerEvent<HTMLSpanElement>): void => {
        if (event.pointerType !== "mouse" || dismissedUntilBlur) return;
        clearOpenTimer();
        openTimerRef.current = window.setTimeout(() => {
            setMouseHovering(true);
            openTimerRef.current = null;
        }, hoverDelayMs);
    };

    const handlePointerLeave = (event: ReactPointerEvent<HTMLSpanElement>): void => {
        if (event.pointerType !== "mouse") return;
        clearOpenTimer();
        setMouseHovering(false);
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLSpanElement>): void => {
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        event.stopPropagation();
        clearOpenTimer();
        setTouchOpen((current) => !current);
    };

    const handleFocus = (event: ReactFocusEvent<HTMLSpanElement>): void => {
        if (dismissedUntilBlur) return;
        if (!event.currentTarget.matches(":focus-visible")) return;
        clearOpenTimer();
        setKeyboardFocused(true);
    };

    const handleBlur = (): void => {
        clearOpenTimer();
        setKeyboardFocused(false);
        setDismissedUntilBlur(false);
    };

    useEffect(() => {
        if (!open) return;

        const handleDocumentPointerDown = (event: PointerEvent): void => {
            const trigger = triggerRef.current;
            if (trigger && event.target instanceof Node && trigger.contains(event.target)) return;
            setMouseHovering(false);
            setTouchOpen(false);
            setKeyboardFocused(false);
        };

        const handleDocumentKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            clearOpenTimer();
            setMouseHovering(false);
            setTouchOpen(false);
            if (triggerRef.current === document.activeElement) {
                setDismissedUntilBlur(true);
            }
        };

        document.addEventListener("pointerdown", handleDocumentPointerDown, true);
        document.addEventListener("keydown", handleDocumentKeyDown);

        return () => {
            document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
            document.removeEventListener("keydown", handleDocumentKeyDown);
        };
    }, [open]);

    useEffect(() => {
        return () => clearOpenTimer();
    }, []);

    return (
        <>
            <span
                ref={triggerRef}
                className="settings-info"
                role="img"
                tabIndex={0}
                aria-label={ariaLabel}
                aria-describedby={describedById}
                onPointerEnter={handlePointerEnter}
                onPointerLeave={handlePointerLeave}
                onPointerDown={handlePointerDown}
                onFocus={handleFocus}
                onBlur={handleBlur}
            >
                {children}
                {open && (
                    <span className="info-tooltip" aria-hidden="true">
                        {content}
                    </span>
                )}
            </span>
            <span id={describedById} className="visually-hidden">
                {content}
            </span>
        </>
    );
};
