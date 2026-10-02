import { Composition } from 'remotion'
import { Capi, DURATION } from './Capi'

export const Root = () => (
  <>
    <Composition id="Capi" component={Capi} durationInFrames={DURATION} fps={30} width={1080} height={1080} />
    <Composition id="CapiWide" component={Capi} durationInFrames={DURATION} fps={30} width={1920} height={1080} />
  </>
)
