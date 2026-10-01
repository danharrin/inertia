import { Poll, PollCallback } from './poll'
import type { RouterContext } from './routerContext'
import { PollOptions } from './types'

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
    if (typeof document === 'undefined') {
      return () => {}
    }

    const listener = () => {
      this.polls.forEach((poll) => poll.isInBackground(document.hidden))
    }

    document.addEventListener('visibilitychange', listener, false)

    return () => document.removeEventListener('visibilitychange', listener, false)
  }
}
