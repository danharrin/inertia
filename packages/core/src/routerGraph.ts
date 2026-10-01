import { RouterContext } from './routerContext'

let currentContext = new RouterContext()

export const getCurrentContext = (): RouterContext => currentContext

export const publishContext = (context: RouterContext): void => {
  currentContext = context
}
