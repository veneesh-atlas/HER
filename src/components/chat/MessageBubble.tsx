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
  /** True when this message is actively being streamed */
  isStreaming?: boolean;
}

export default function MessageBubble({ message, showTimestamp = false, index = 0, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const hasImage = !!message.image;
  const hasText = message.content.length > 0 && message.content !== "(shared a photo)";
  const isShort = !hasImage && message.content.length <= 40;
  const isLong = !hasImage && message.content.length > 600;
  const isEmptyStreaming = isStreaming && !hasText && !hasImage;
  const isImageLoading = !!message.imageLoading;
  const isGeneratedImage = hasImage && !isUser;

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className={`mb-4 flex flex-col sm:mb-5 ${
        isUser ? "animate-message-in items-end" : "animate-assistant-in items-start"
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
        className={`message-content rounded-[18px] sm:rounded-[20px] ${
          hasImage && !hasText
            ? "max-w-[75%] overflow-hidden p-1 sm:max-w-[65%] sm:p-1.5 md:max-w-[50%]"
            : hasImage && hasText
            ? "max-w-[85%] overflow-hidden p-1 sm:max-w-[80%] sm:p-1.5 md:max-w-[70%]"
            : isShort
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
        {/* Image loading shimmer */}
        {isImageLoading && !hasImage && (
          <div className="animate-image-shimmer w-full rounded-[14px] sm:rounded-[16px]" style={{ height: "240px" }} />
        )}

        {/* Image — user-attached or AI-generated */}
        {hasImage && (
          <img
            src={message.image}
            alt={isGeneratedImage ? "Generated image" : "Shared photo"}
            className={`w-full rounded-[14px] object-cover sm:rounded-[16px] ${
              isGeneratedImage ? "animate-fade-in shadow-[0_2px_16px_rgba(180,140,110,0.18)]" : ""
            } ${hasText ? "mb-2" : ""}`}
            style={{ maxHeight: isGeneratedImage ? "360px" : "280px" }}
          />
        )}

        {/* Streaming presence — shown when content is still empty */}
        {isEmptyStreaming && (
          <div className="flex items-center gap-2 px-1 py-0.5">
            <div className="animate-presence-breathe h-[5px] w-[5px] rounded-full bg-her-accent/50" />
            <div className="flex items-center gap-[3px]">
              <span className="h-[3px] w-[3px] rounded-full bg-her-accent/20" style={{ animation: "softPulse 2s ease-in-out infinite" }} />
              <span className="h-[3px] w-[3px] rounded-full bg-her-accent/20" style={{ animation: "softPulse 2s ease-in-out infinite", animationDelay: "0.4s" }} />
              <span className="h-[3px] w-[3px] rounded-full bg-her-accent/20" style={{ animation: "softPulse 2s ease-in-out infinite", animationDelay: "0.8s" }} />
            </div>
          </div>
        )}

        {/* Text */}
        {hasText && (
          <div className={`text-[13.5px] leading-[1.65] sm:text-[14.5px] sm:leading-[1.7] ${hasImage ? "px-3 pb-2 pt-1 sm:px-3.5" : ""}`}>
            {message.content.split("\n").map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
            {isStreaming && <span className="animate-stream-cursor" />}
          </div>
        )}
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
