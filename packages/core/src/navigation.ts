import { ExternalNavigationOptions } from './types'

// Each mount keeps its own navigation state, including after disposal.
export class Navigation {
  public external: ExternalNavigationOptions | undefined
  public active = true
}
