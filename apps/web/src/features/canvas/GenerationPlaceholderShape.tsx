import { BaseBoxShapeUtil, HTMLContainer, RecordProps, T, TLShape } from "tldraw";
import { useI18n } from "../../shared/i18n";

export const GENERATION_PLACEHOLDER_TYPE = "generation-placeholder" as const;

export type GenerationPlaceholderStatus = "loading" | "failed";

interface GenerationPlaceholderProps {
  w: number;
  h: number;
  targetWidth: number;
  targetHeight: number;
  status: GenerationPlaceholderStatus;
  error: string;
  requestId: string;
  outputIndex: number;
}

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    [GENERATION_PLACEHOLDER_TYPE]: GenerationPlaceholderProps;
  }
}

export type GenerationPlaceholderShape = TLShape<typeof GENERATION_PLACEHOLDER_TYPE>;

function conciseError(message: string, fallback: string): string {
  const trimmed = message.trim() || fallback;
  return trimmed.length > 46 ? `${trimmed.slice(0, 46)}...` : trimmed;
}

function GenerationPlaceholderLoadingArt({ label }: { label: string }) {
  return (
    <div className="generation-placeholder-shape__content">
      <div className="generation-placeholder-shape__art" aria-hidden="true">
        <svg className="generation-placeholder-shape__picture" viewBox="0 0 100 100" fill="none" focusable="false" xmlns="http://www.w3.org/2000/svg">
          <rect className="generation-placeholder-shape__draw" x="10" y="15" width="80" height="70" rx="12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle className="generation-placeholder-shape__draw generation-placeholder-shape__draw--sun" cx="70" cy="35" r="8" stroke="currentColor" strokeWidth="3" />
          <path className="generation-placeholder-shape__draw generation-placeholder-shape__draw--mountain-one" d="M10 70 L40 40 L65 65" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <path className="generation-placeholder-shape__draw generation-placeholder-shape__draw--mountain-two" d="M50 65 L65 50 L90 75" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg className="generation-placeholder-shape__spark generation-placeholder-shape__spark--large" viewBox="0 0 100 100" fill="none" focusable="false">
          <path d="M50 0 C50 25 75 50 100 50 C75 50 50 75 50 100 C50 75 25 50 0 50 C25 50 50 25 50 0 Z" fill="currentColor" opacity="0.8" />
        </svg>
        <svg className="generation-placeholder-shape__spark generation-placeholder-shape__spark--small" viewBox="0 0 100 100" fill="none" focusable="false">
          <path d="M50 0 C50 25 75 50 100 50 C75 50 50 75 50 100 C50 75 25 50 0 50 C25 50 50 25 50 0 Z" fill="currentColor" opacity="0.6" />
        </svg>
      </div>
      <div className="generation-placeholder-shape__status-panel" role="status" aria-label={label}>
        <span className="generation-placeholder-shape__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="generation-placeholder-shape__magic-text">{label}</span>
      </div>
    </div>
  );
}

function GenerationPlaceholderContent({ shape }: { shape: GenerationPlaceholderShape }) {
  const { t } = useI18n();
  const isFailed = shape.props.status === "failed";

  return (
    <HTMLContainer
      className={`generation-placeholder-shape ${isFailed ? "is-failed" : "is-loading"}`}
      data-generation-placeholder-status={shape.props.status}
    >
      {isFailed ? (
        <div className="generation-placeholder-shape__content generation-placeholder-shape__content--failed">
          <div className="generation-placeholder-shape__error-mark" aria-hidden="true">
            !
          </div>
          <div className="generation-placeholder-shape__title">{t("generationCanvasFailed")}</div>
          <div className="generation-placeholder-shape__copy">
            {conciseError(shape.props.error, t("generationErrorDefault"))}
          </div>
        </div>
      ) : (
        <>
          <div className="generation-placeholder-shape__inner-glow" aria-hidden="true" />
          <GenerationPlaceholderLoadingArt label={t("generationCanvasMagicLoading")} />
        </>
      )}
    </HTMLContainer>
  );
}

export class GenerationPlaceholderShapeUtil extends BaseBoxShapeUtil<GenerationPlaceholderShape> {
  static override type = GENERATION_PLACEHOLDER_TYPE;
  static override props: RecordProps<GenerationPlaceholderShape> = {
    w: T.number,
    h: T.number,
    targetWidth: T.number,
    targetHeight: T.number,
    status: T.literalEnum("loading", "failed"),
    error: T.string,
    requestId: T.string,
    outputIndex: T.number
  };

  override canBind(): boolean {
    return false;
  }

  override canResize(): boolean {
    return false;
  }

  override isAspectRatioLocked(): boolean {
    return true;
  }

  override getDefaultProps(): GenerationPlaceholderShape["props"] {
    return {
      w: 300,
      h: 300,
      targetWidth: 1024,
      targetHeight: 1024,
      status: "loading",
      error: "",
      requestId: "",
      outputIndex: 0
    };
  }

  override component(shape: GenerationPlaceholderShape) {
    return <GenerationPlaceholderContent shape={shape} />;
  }

  override indicator(shape: GenerationPlaceholderShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />;
  }
}
