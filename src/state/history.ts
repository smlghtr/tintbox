import type { SelectionMask } from '../core/selection';
import type { Doc } from '../core/types';

export interface CommandContext {
  doc: Doc;
  getSelection: () => SelectionMask | null;
  setSelection: (m: SelectionMask | null) => void;
  getActiveLayerId: () => string;
  setActiveLayerId: (id: string) => void;
  getActiveFrame: () => number;
  setActiveFrame: (frame: number) => void;
  markDirty: (frame?: number) => void;
}

export interface Command {
  readonly label: string;
  readonly byteSize: number;
  readonly scope?: 'canvas' | 'settings';
  readonly layerId?: string;
  readonly frame?: number;
  do(ctx: CommandContext): void;
  undo(ctx: CommandContext): void;
}

export interface HistoryEntryView {
  index: number;
  label: string;
  current: boolean;
  undone: boolean;
}

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private bytes = 0;
  maxSteps: number;
  maxBytes: number;

  constructor(maxSteps = DEFAULT_MAX_STEPS, maxBytes = DEFAULT_MAX_BYTES) {
    this.maxSteps = maxSteps;
    this.maxBytes = maxBytes;
  }

  setLimits(maxSteps: number, maxBytes: number): void {
    this.maxSteps = Math.max(10, Math.round(maxSteps));
    this.maxBytes = Math.max(4 * 1024 * 1024, Math.round(maxBytes));
    this.evict();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  get length(): number {
    return this.undoStack.length;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  getEntries(): HistoryEntryView[] {
    const out: HistoryEntryView[] = [
      { index: 0, label: 'Initial state', current: this.undoStack.length === 0, undone: false },
    ];
    for (let i = 0; i < this.undoStack.length; i++) {
      out.push({
        index: i + 1,
        label: this.undoStack[i].label,
        current: i === this.undoStack.length - 1,
        undone: false,
      });
    }
    for (let j = this.redoStack.length - 1; j >= 0; j--) {
      const idx = this.undoStack.length + (this.redoStack.length - j);
      out.push({
        index: idx,
        label: this.redoStack[j].label,
        current: false,
        undone: true,
      });
    }
    return out;
  }

  jumpTo(targetIndex: number, ctx: CommandContext, blocked = false): boolean {
    if (blocked) return false;
    const total = this.undoStack.length + this.redoStack.length;
    const clamped = Math.max(0, Math.min(total, targetIndex));
    if (clamped === this.undoStack.length) return false;
    while (this.undoStack.length > clamped) {
      if (!this.undo(ctx, false)) break;
    }
    while (this.undoStack.length < clamped) {
      if (!this.redo(ctx, false)) break;
    }
    return true;
  }

  execute(cmd: Command, ctx: CommandContext): void {
    cmd.do(ctx);
    this.undoStack.push(cmd);
    this.bytes += Math.max(0, cmd.byteSize);
    for (const r of this.redoStack) this.bytes -= Math.max(0, r.byteSize);
    this.redoStack.length = 0;
    this.evict();
  }

  undo(ctx: CommandContext, blocked = false): Command | null {
    if (blocked) return null;
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo(ctx);
    this.restoreFocus(cmd, ctx);
    this.redoStack.push(cmd);
    return cmd;
  }

  redo(ctx: CommandContext, blocked = false): Command | null {
    if (blocked) return null;
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.do(ctx);
    this.restoreFocus(cmd, ctx);
    this.undoStack.push(cmd);
    return cmd;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.bytes = 0;
  }

  private restoreFocus(cmd: Command, ctx: CommandContext): void {
    if (cmd.layerId && ctx.doc.layers.some((l) => l.id === cmd.layerId)) {
      ctx.setActiveLayerId(cmd.layerId);
    } else if (!ctx.doc.layers.some((l) => l.id === ctx.getActiveLayerId()) && ctx.doc.layers.length > 0) {
      ctx.setActiveLayerId(ctx.doc.layers[ctx.doc.layers.length - 1].id);
    }
    if (cmd.frame !== undefined && cmd.frame >= 0 && cmd.frame < ctx.doc.frames.length) {
      ctx.setActiveFrame(cmd.frame);
    } else if (ctx.getActiveFrame() >= ctx.doc.frames.length) {
      ctx.setActiveFrame(Math.max(0, ctx.doc.frames.length - 1));
    }
  }

  private evict(): void {
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > this.maxSteps || this.bytes > this.maxBytes)
    ) {
      const oldest = this.undoStack.shift();
      if (oldest) this.bytes -= Math.max(0, oldest.byteSize);
    }
    if (this.bytes < 0) this.bytes = 0;
  }
}
