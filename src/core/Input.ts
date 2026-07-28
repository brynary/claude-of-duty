/**
 * Pointer-lock mouse look plus keyboard state. Mouse deltas accumulate between
 * frames and are drained by the camera rig, so look is never frame-rate bound.
 */
/**
 * A frame of synthetic input. The play harness writes one of these each frame
 * and the rest of the game cannot tell the difference, which is the point: a
 * scripted run exercises the real character controller, weapon timings and AI
 * rather than a parallel code path that could drift from them.
 */
export interface ScriptedFrame {
  down: Set<string>
  pressed: Set<string>
  mouseDX: number
  mouseDY: number
  mouse0: boolean
  mouse1: boolean
  mouse0Pressed: boolean
  mouse1Pressed: boolean
  wheelDelta: number
}

export function emptyScriptedFrame(): ScriptedFrame {
  return {
    down: new Set(), pressed: new Set(),
    mouseDX: 0, mouseDY: 0, wheelDelta: 0,
    mouse0: false, mouse1: false, mouse0Pressed: false, mouse1Pressed: false,
  }
}

export class Input {
  private down = new Set<string>()
  private pressedThisFrame = new Set<string>()
  private releasedThisFrame = new Set<string>()

  private rawMouseDX = 0
  private rawMouseDY = 0
  private rawWheel = 0
  private rawMouse0 = false
  private rawMouse1 = false
  private rawMouse0Pressed = false
  private rawMouse1Pressed = false

  /** When set, every read below comes from here instead of the hardware. */
  scripted: ScriptedFrame | null = null

  locked = false

  get mouseDX(): number { return this.scripted ? this.scripted.mouseDX : this.rawMouseDX }
  set mouseDX(v: number) { this.rawMouseDX = v }
  get mouseDY(): number { return this.scripted ? this.scripted.mouseDY : this.rawMouseDY }
  set mouseDY(v: number) { this.rawMouseDY = v }
  get wheelDelta(): number { return this.scripted ? this.scripted.wheelDelta : this.rawWheel }
  set wheelDelta(v: number) { this.rawWheel = v }
  get mouse0(): boolean { return this.scripted ? this.scripted.mouse0 : this.rawMouse0 }
  set mouse0(v: boolean) { this.rawMouse0 = v }
  get mouse1(): boolean { return this.scripted ? this.scripted.mouse1 : this.rawMouse1 }
  set mouse1(v: boolean) { this.rawMouse1 = v }
  get mouse0Pressed(): boolean { return this.scripted ? this.scripted.mouse0Pressed : this.rawMouse0Pressed }
  set mouse0Pressed(v: boolean) { this.rawMouse0Pressed = v }
  get mouse1Pressed(): boolean { return this.scripted ? this.scripted.mouse1Pressed : this.rawMouse1Pressed }
  set mouse1Pressed(v: boolean) { this.rawMouse1Pressed = v }

  /** Set false while a menu is open so gameplay ignores input. */
  enabled = true

  private element: HTMLElement | null = null
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.element
    if (!this.locked) this.down.clear()
  }

  attach(element: HTMLElement): void {
    this.element = element
    window.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('keyup', this.handleKeyUp)
    window.addEventListener('mousemove', this.handleMouseMove)
    window.addEventListener('mousedown', this.handleMouseDown)
    window.addEventListener('mouseup', this.handleMouseUp)
    window.addEventListener('wheel', this.handleWheel, { passive: true })
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('pointerlockchange', this.onLockChange)
    element.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  requestLock(): void {
    this.element?.requestPointerLock()
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    this.down.add(e.code)
    this.pressedThisFrame.add(e.code)
    // Stop the browser scrolling/searching out from under the game.
    if (['Space', 'Tab', 'KeyR', 'Slash', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault()
  }

  private handleKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code)
    this.releasedThisFrame.add(e.code)
  }

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.locked) return
    this.mouseDX += e.movementX
    this.mouseDY += e.movementY
  }

  private handleMouseDown = (e: MouseEvent) => {
    if (e.button === 0) { this.mouse0 = true; this.mouse0Pressed = true }
    if (e.button === 2) { this.mouse1 = true; this.mouse1Pressed = true }
  }

  private handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouse0 = false
    if (e.button === 2) this.mouse1 = false
  }

  private handleWheel = (e: WheelEvent) => { this.wheelDelta += e.deltaY }

  private handleBlur = () => {
    this.down.clear()
    this.mouse0 = this.mouse1 = false
  }

  isDown(code: string): boolean {
    if (this.scripted) return this.scripted.down.has(code)
    return this.enabled && this.down.has(code)
  }

  wasPressed(code: string): boolean {
    if (this.scripted) return this.scripted.pressed.has(code)
    return this.enabled && this.pressedThisFrame.has(code)
  }

  wasReleased(code: string): boolean {
    return this.enabled && this.releasedThisFrame.has(code)
  }

  /** Axis helper: returns -1, 0 or 1. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0)
  }

  /** Called once per frame, after all systems have read input. */
  endFrame(): void {
    this.rawMouseDX = 0
    this.rawMouseDY = 0
    this.rawWheel = 0
    this.rawMouse0Pressed = false
    this.rawMouse1Pressed = false
    this.pressedThisFrame.clear()
    this.releasedThisFrame.clear()
    if (this.scripted) {
      // The bot rewrites these before the next update; clearing the edge-
      // triggered members here keeps a stale press from lasting two frames.
      this.scripted.pressed.clear()
      this.scripted.mouse0Pressed = false
      this.scripted.mouse1Pressed = false
      this.scripted.mouseDX = 0
      this.scripted.mouseDY = 0
      this.scripted.wheelDelta = 0
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('keyup', this.handleKeyUp)
    window.removeEventListener('mousemove', this.handleMouseMove)
    window.removeEventListener('mousedown', this.handleMouseDown)
    window.removeEventListener('mouseup', this.handleMouseUp)
    window.removeEventListener('wheel', this.handleWheel)
    window.removeEventListener('blur', this.handleBlur)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }
}
