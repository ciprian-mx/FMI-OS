import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Accessible popup menu used by the Materials tree (Task 4.2).
 *
 * Follows the WAI-ARIA menu pattern for a menu opened by right-click, by the
 * context-menu key / Shift+F10, or by a "More actions" button:
 *   • `role="menu"` containing `role="menuitem"` buttons. Focus moves to the
 *     first item when the menu opens; items are not in the Tab sequence.
 *   • ArrowDown / ArrowUp move between items (wrapping), Home / End jump to the
 *     first / last item, Enter / Space activate the focused item.
 *   • Escape and Tab dismiss the menu, as does a press anywhere outside it or
 *     focus moving somewhere else.
 *
 * The owner decides where focus goes after the menu closes, based on the
 * {@link ContextMenuCloseReason} passed to `onClose`.
 *
 * The menu renders into a portal on `document.body` with fixed positioning so
 * the scrolling tree and the window panel's `overflow: hidden` never clip it,
 * and it is nudged back inside the viewport when it would overflow an edge.
 */

/** Viewport coordinates (CSS pixels) of the menu's top-left corner. */
export interface MenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  /** Stable id, also used for the item's `data-testid` (`menu-item-{id}`). */
  id: string;
  label: string;
  onSelect: () => void;
  /** Destructive items (Delete) get danger styling. */
  danger?: boolean;
}

/**
 * Why the menu closed:
 *   - `escape` / `tab`: keyboard dismissal; the owner should restore focus.
 *   - `outside`: a press outside the menu; focus follows the press.
 *   - `focusout`: focus moved outside the menu by other means.
 *   - `select`: an item was activated; the item's action takes over focus.
 */
export type ContextMenuCloseReason =
  | 'escape'
  | 'tab'
  | 'outside'
  | 'focusout'
  | 'select';

export interface ContextMenuProps {
  /** DOM id, referenced by the trigger's `aria-controls`. */
  id: string;
  /** Accessible name of the menu, e.g. "Actions for Week 3". */
  label: string;
  items: readonly ContextMenuItem[];
  position: MenuPosition;
  /**
   * The "More actions" button that opened the menu, if any. Presses on it are
   * not "outside" presses, so the button's own click can toggle the menu shut.
   */
  triggerElement?: HTMLElement | null;
  onClose: (reason: ContextMenuCloseReason) => void;
}

/** Minimum gap kept between the menu and the viewport edges. */
const VIEWPORT_MARGIN = 4;

const ContextMenu: React.FC<ContextMenuProps> = ({
  id,
  label,
  items,
  position,
  triggerElement,
  onClose,
}) => {
  const menuRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [placement, setPlacement] = useState<MenuPosition>(position);

  // Document listeners always call the latest `onClose`.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus the first item as soon as the menu is on screen.
  useLayoutEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  // Keep the menu inside the viewport: shift it left near the right edge and
  // flip it above the anchor near the bottom edge.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    const maxX = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxY = window.innerHeight - height - VIEWPORT_MARGIN;
    const x = Math.max(VIEWPORT_MARGIN, Math.min(position.x, maxX));
    const y =
      position.y > maxY
        ? Math.max(VIEWPORT_MARGIN, position.y - height)
        : position.y;
    setPlacement((current) =>
      current.x === x && current.y === y ? current : { x, y }
    );
  }, [position.x, position.y]);

  // Dismiss on a press outside the menu (pointer or mouse, capture phase so an
  // inner handler cannot swallow it) and when focus moves elsewhere. Registered
  // as a layout effect so the listeners are gone the moment the menu unmounts,
  // before whatever replaces it takes focus.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return undefined;
    }
    const doc = menu.ownerDocument;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      (menu.contains(target) || Boolean(triggerElement?.contains(target)));
    const handlePress = (event: Event) => {
      if (!isInside(event.target)) {
        onCloseRef.current('outside');
      }
    };
    const handleFocusIn = (event: Event) => {
      if (!isInside(event.target)) {
        onCloseRef.current('focusout');
      }
    };
    doc.addEventListener('pointerdown', handlePress, true);
    doc.addEventListener('mousedown', handlePress, true);
    doc.addEventListener('focusin', handleFocusIn, true);
    return () => {
      doc.removeEventListener('pointerdown', handlePress, true);
      doc.removeEventListener('mousedown', handlePress, true);
      doc.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [triggerElement]);

  const focusItem = (index: number) => {
    const count = items.length;
    if (count === 0) {
      return;
    }
    itemRefs.current[((index % count) + count) % count]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const current = itemRefs.current.findIndex((item) => item === event.target);
    switch (event.key) {
      case 'ArrowDown':
        focusItem(current + 1);
        break;
      case 'ArrowUp':
        focusItem(current < 0 ? items.length - 1 : current - 1);
        break;
      case 'Home':
        focusItem(0);
        break;
      case 'End':
        focusItem(items.length - 1);
        break;
      case 'Escape':
      case 'Esc':
        onClose('escape');
        break;
      case 'Tab':
        onClose('tab');
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <ul
      ref={menuRef}
      id={id}
      className="materials-menu"
      role="menu"
      aria-label={label}
      data-testid="materials-context-menu"
      style={{ left: `${placement.x}px`, top: `${placement.y}px` }}
      onKeyDown={handleKeyDown}
      // Our menu replaces the browser's; never stack the native one on top.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item, index) => (
        <li key={item.id} role="none">
          <button
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={
              'materials-menu__item' +
              (item.danger ? ' materials-menu__item--danger' : '')
            }
            data-testid={`menu-item-${item.id}`}
            onClick={() => {
              onClose('select');
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>,
    document.body
  );
};

export default ContextMenu;
