/**
 * Pointer-lock mouse look plus keyboard state. Mouse deltas accumulate between
 * frames and are drained by the camera rig, so look is never frame-rate bound.
 *
 * Held state is *reconciled*, never merely accumulated. Every event the browser
 * delivers carries the truth about the modifier keys (`getModifierState`) and
 * about the mouse buttons (`MouseEvent.buttons`), so both are re-derived on
 * every event rather than tracked from edges alone.
 *
 * That matters because edges go missing routinely, and on macOS constantly:
 * the system withholds `keyup` for other keys while Command is held, a native
 * context menu swallows the `mouseup` that would have ended an aim, and this
 * class drops its own key set whenever the pointer lock goes. Modifier keys
 * never auto-repeat, so a `ShiftLeft` lost that way used to stay lost until the
 * player happened to release and press it again — the game walking while the
 * hand held sprint, an aim that would not end. Reconciling means the next event
 * of any kind puts it right, and a mouse being moved is an event.
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

/**
 * The modifiers the game binds, paired with their `getModifierState` name.
 *
 * That call cannot tell left from right. Only the left codes are bound, so
 * either side reconciles to the bound code — which costs nothing and quietly
 * makes the right-hand keys work as well.
 */
const MODIFIERS: readonly (readonly [code: string, state: string])[] = [
  ['ShiftLeft', 'Shift'],
  ['ControlLeft', 'Control'],
  ['AltLeft', 'Alt'],
]

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
  // The four button reads honour `enabled` exactly as `isDown` does. They did
  // not, which meant a click on a pause-menu button still reached the weapon:
  // the simulation keeps running behind the menu, so the trigger and the aim
  // were both live while the player was picking a menu item.
  get mouse0(): boolean { return this.scripted ? this.scripted.mouse0 : this.enabled && this.rawMouse0 }
  set mouse0(v: boolean) { this.rawMouse0 = v }
  get mouse1(): boolean { return this.scripted ? this.scripted.mouse1 : this.enabled && this.rawMouse1 }
  set mouse1(v: boolean) { this.rawMouse1 = v }
  get mouse0Pressed(): boolean {
    return this.scripted ? this.scripted.mouse0Pressed : this.enabled && this.rawMouse0Pressed
  }
  set mouse0Pressed(v: boolean) { this.rawMouse0Pressed = v }
  get mouse1Pressed(): boolean {
    return this.scripted ? this.scripted.mouse1Pressed : this.enabled && this.rawMouse1Pressed
  }
  set mouse1Pressed(v: boolean) { this.rawMouse1Pressed = v }

  /** Set false while a menu is open so gameplay ignores input. */
  enabled = true

  private element: HTMLElement | null = null
  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.element
    if (!this.locked) this.forgetHeld()
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
    // On the window, not on the canvas. The HUD and the menus are sibling
    // overlays rather than children of it, so a canvas-only guard let a right
    // click on a menu raise the native menu — which then took the `mouseup`
    // with it and left the player aiming for the rest of the match.
    window.addEventListener('contextmenu', this.handleContextMenu)
  }

  requestLock(): void {
    this.element?.requestPointerLock()
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  /**
   * Reconcile the bound modifiers against what the event says is really held.
   * Never touches `pressedThisFrame`: re-seating a key is not a fresh press,
   * and a synthetic one here would fire the double-tap tactical sprint.
   */
  private syncModifiers(e: KeyboardEvent | MouseEvent): void {
    for (const [code, state] of MODIFIERS) {
      if (e.getModifierState(state)) this.down.add(code)
      else this.down.delete(code)
    }
  }

  /**
   * Reconcile both buttons from the event's own bitmask, which is the browser's
   * record of what is held at this instant. A `mouseup` lost to a native menu
   * or an app switch is corrected by the next mouse movement instead of leaving
   * the player permanently aiming at 2.7 m/s.
   */
  private syncButtons(e: MouseEvent): void {
    this.rawMouse0 = (e.buttons & 1) !== 0
    this.rawMouse1 = (e.buttons & 2) !== 0
  }

  /** Drop everything held. Both callers lose sight of the keyboard, and the
   * reconcilers above earn it back on the next event. */
  private forgetHeld(): void {
    this.down.clear()
    this.rawMouse0 = false
    this.rawMouse1 = false
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    this.syncModifiers(e)
    // Auto-repeat is the only event an ordinary held key emits, so it is also
    // the only chance to notice one that is still down after the set was
    // cleared. Re-seat it, then leave: a repeat is not a press.
    this.down.add(e.code)
    // Stop the browser scrolling/searching out from under the game. Before the
    // repeat check, or holding space scrolls the page from the second event on.
    if (['Space', 'Tab', 'KeyR', 'Slash', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault()
    if (e.repeat) return
    this.pressedThisFrame.add(e.code)
  }

  private handleKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code)
    this.syncModifiers(e)
    this.releasedThisFrame.add(e.code)
  }

  private handleMouseMove = (e: MouseEvent) => {
    // Reconciled before the lock test, not after. An unlocked mouse still
    // reports the truth, and the moment the player is most likely to be holding
    // a desynced key is the moment they are clicking their way out of a menu.
    this.syncModifiers(e)
    this.syncButtons(e)
    if (!this.locked) return
    this.mouseDX += e.movementX
    this.mouseDY += e.movementY
  }

  private handleMouseDown = (e: MouseEvent) => {
    this.syncModifiers(e)
    this.syncButtons(e)
    if (e.button === 0) this.mouse0Pressed = true
    if (e.button === 2) this.mouse1Pressed = true
  }

  private handleMouseUp = (e: MouseEvent) => {
    this.syncModifiers(e)
    this.syncButtons(e)
  }

  private handleWheel = (e: WheelEvent) => { this.wheelDelta += e.deltaY }

  private handleContextMenu = (e: Event) => { e.preventDefault() }

  private handleBlur = () => { this.forgetHeld() }

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
    window.removeEventListener('contextmenu', this.handleContextMenu)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }
}
