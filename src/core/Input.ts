/**
 * Pointer-lock mouse look plus keyboard state. Mouse deltas accumulate between
 * frames and are drained by the camera rig, so look is never frame-rate bound.
 */
export class Input {
  private down = new Set<string>()
  private pressedThisFrame = new Set<string>()
  private releasedThisFrame = new Set<string>()

  mouseDX = 0
  mouseDY = 0
  wheelDelta = 0
  mouse0 = false
  mouse1 = false
  mouse0Pressed = false
  mouse1Pressed = false
  locked = false

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
    return this.enabled && this.down.has(code)
  }

  wasPressed(code: string): boolean {
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
    this.mouseDX = 0
    this.mouseDY = 0
    this.wheelDelta = 0
    this.mouse0Pressed = false
    this.mouse1Pressed = false
    this.pressedThisFrame.clear()
    this.releasedThisFrame.clear()
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
