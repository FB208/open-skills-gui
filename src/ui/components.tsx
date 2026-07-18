import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';

type IconName =
  | 'apps'
  | 'search'
  | 'settings'
  | 'refresh'
  | 'download'
  | 'upload'
  | 'pause'
  | 'play'
  | 'trash'
  | 'edit'
  | 'close'
  | 'check'
  | 'warning'
  | 'info'
  | 'terminal'
  | 'link'
  | 'shield'
  | 'chevron';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

/** 渲染不依赖外部字体的线性图标。 */
export function Icon({ name, size = 18, className }: IconProps): JSX.Element {
  const paths: Record<IconName, ComponentChildren> = {
    apps: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06A1.7 1.7 0 0 0 19.43 9 1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </>
    ),
    upload: (
      <>
        <path d="M12 21V9" />
        <path d="m7 14 5-5 5 5" />
        <path d="M5 3h14" />
      </>
    ),
    pause: (
      <>
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7Z" />,
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="m9 7 1-3h4l1 3" />
        <path d="m6 7 1 14h10l1-14" />
        <path d="M10 11v6M14 11v6" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="m16.5 3.5 4 4L8 20l-5 1 1-5Z" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    warning: (
      <>
        <path d="M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7h.01" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3M13 15h4" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
        <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
      </>
    ),
    shield: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
        <path d="m9 12 2 2 4-5" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
  };

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.8"
    >
      {paths[name]}
    </svg>
  );
}

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ComponentChildren;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'normal' | 'small' | 'icon';
  busy?: boolean;
}

/** 渲染统一样式并支持忙碌态的按钮。 */
export function Button({
  children,
  variant = 'secondary',
  size = 'normal',
  busy = false,
  className,
  disabled,
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      {...props}
      className={`button button--${variant} button--${size} ${className ?? ''}`}
      disabled={disabled || busy}
      aria-busy={busy}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  width?: 'small' | 'normal' | 'wide';
  closeLabel?: string;
  onClose?: () => void;
}

/** 使用原生对话框提供焦点约束、回焦和 Escape 关闭行为。 */
export function Modal({
  open,
  title,
  description,
  children,
  footer,
  width = 'normal',
  closeLabel = '关闭',
  onClose,
}: ModalProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /** 将原生取消事件交由上层决定是否关闭。 */
  const handleCancel = (event: Event): void => {
    event.preventDefault();
    onClose?.();
  };

  return (
    <dialog
      ref={ref}
      className={`modal modal--${width}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={handleCancel}
    >
      <div className="modal__header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        {onClose ? (
          <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
            <Icon name="close" />
          </Button>
        ) : null}
      </div>
      <div className="modal__body">{children}</div>
      {footer ? <div className="modal__footer">{footer}</div> : null}
    </dialog>
  );
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error' | 'info';
}

/** 在右下角展示非阻塞操作反馈。 */
export function ToastRegion({ messages }: { messages: ToastMessage[] }): JSX.Element {
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {messages.map((message) => (
        <div key={message.id} className={`toast toast--${message.tone}`}>
          <span className="toast__icon">
            <Icon
              name={
                message.tone === 'success' ? 'check' : message.tone === 'error' ? 'warning' : 'info'
              }
              size={16}
            />
          </span>
          <span>{message.text}</span>
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  icon: IconName;
  title: string;
  body: string;
  action?: ComponentChildren;
}

/** 展示没有数据时的明确下一步。 */
export function EmptyState({ icon, title, body, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
