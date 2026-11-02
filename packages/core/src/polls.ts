import { Poll, PollCallback } from './poll'
import type { RouterContext } from './routerContext'
import { PollOptions } from './types'
import { visibility } from './visibility'

export class Polls {
  protected polls: Poll[] = []

  constructor(protected context: RouterContext) {}

  public get count(): number {
    return this.polls.length
  }

  public add(
    interval: number,
    cb: PollCallback,
    options: PollOptions,
  ): {
    stop: VoidFunction
    start: VoidFunction
    destroy: VoidFunction
  } {
    const poll = new Poll(interval, this.context.callback(cb), {
      ...options,
      autoStart: (options.autoStart ?? true) && this.context.navigation.active,
    })

    // A tab that was already hidden never fires `visibilitychange`, so the
    // listener below would leave this poll running at full cadence
    poll.isInBackground(visibility.isHidden())

    this.polls.push(poll)

    return {
      stop: () => poll.stop(),
      start: this.context.callback(() => poll.start()),
      destroy: () => {
        poll.stop()
        this.polls = this.polls.filter((p) => p !== poll)
      },
    }
  }

  public clear() {
    this.polls.forEach((poll) => poll.stop())

    this.polls = []
  }

  public init(): VoidFunction {
    return visibility.onChange((hidden) => {
      this.polls.forEach((poll) => poll.isInBackground(hidden))
    })
  }
}
