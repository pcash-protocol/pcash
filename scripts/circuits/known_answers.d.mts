export interface KnownAnswer {
  readonly name: string;
  readonly hidingKernel: string;
  readonly runtime: boolean;
  readonly transaction?: boolean;
}

export const KNOWN_ANSWERS: readonly KnownAnswer[];
export function knownAnswerFiles(answer: KnownAnswer): string[];
