import { Message } from "@/lib/types";

/**
 * MessageBubble — A single message in the conversation.
 * User messages: warm terracotta tint, aligned right.
 * HER messages: creamy neutral, aligned left with subtle label.
 * Feels like handwritten notes exchanged between two people.
 */

interface MessageBubbleProps {
  message: Message;
  showTimestamp?: boolean;
  index?: number;
}

export default function MessageBubble({ message, showTimestamp = false, index = 0 }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isShort = message.content.length <= 40;
  const isLong = message.content.length > 600;

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className={`animate-message-in mb-4 flex flex-col sm:mb-5 ${
        isUser ? "items-end" : "items-start"
      }`}
      style={{ animationDelay: `${Math.min(index * 30, 150)}ms`, animationFillMode: "backwards" }}
    >
      {/* Sender label — only for HER */}
      {!isUser && (
        <span className="mb-1 ml-1 text-[9px] font-medium tracking-[0.15em] uppercase text-her-accent/50 sm:text-[10px]">
          her
        </span>
      )}

      {/* Bubble */}
      <div
        className={`message-content rounded-[18px] text-[13.5px] leading-[1.65] sm:rounded-[20px] sm:text-[14.5px] sm:leading-[1.7] ${
          isShort
            ? "max-w-[75%] px-4 py-2.5 sm:max-w-[65%] sm:px-[18px] sm:py-[11px] md:max-w-[50%]"
            : isLong
            ? "max-w-[88%] px-4 py-3 sm:max-w-[82%] sm:px-[18px] sm:py-[14px] md:max-w-[75%]"
            : "max-w-[85%] px-4 py-3 sm:max-w-[80%] sm:px-[18px] sm:py-[14px] md:max-w-[70%]"
        } ${
          isUser
            ? "rounded-br-lg bg-her-user-bubble/90 text-her-text shadow-[0_1px_6px_rgba(180,140,110,0.10)]"
            : "rounded-bl-lg bg-her-ai-bubble/85 text-her-text shadow-[0_1px_4px_rgba(180,140,110,0.07)]"
        }`}
      >
        {/* Whitespace-aware rendering for multi-paragraph messages */}
        {message.content.split("\n").map((line, i) => (
          <span key={i}>
            {i > 0 && <br />}
            {line}
          </span>
        ))}
      </div>

      {/* Timestamp — only show for real timestamps (not the initial greeting) */}
      {showTimestamp && message.timestamp > 0 && (
        <span className={`mt-1.5 text-[10px] tracking-wide text-her-text-muted/30 ${
          isUser ? "mr-1.5" : "ml-1.5"
        }`}>
          {time}
        </span>
      )}
    </div>
  );
}
