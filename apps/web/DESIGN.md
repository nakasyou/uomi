# Recorder viewer

Operate mode, English UI, Material 3. Explicit reference: the supplied Google
Recorder desktop screenshot. Dark charcoal canvas #1f1f1f, low tonal list surfaces
#27292b, selected row #353a42, detail surface #30353b, blue #aac7ff controls and
selection. Text #e3e3e3; secondary #bfc3c7. System Roboto/Noto Sans, 16px body,
24px detail title, 13px timestamp. 48px actions, 24–30px large-container radii.

A compact app bar contains recorder identity and pill search. The left sidebar
holds date groups and bounded recording cards. A single large detail panel splits
real audio waveform from readable transcript. Transport stays below the panel.
Mobile collapses the sidebar into a drawer and stacks waveform/transcript. Empty,
loading and error states name the actual data state. A waveform is generated only
from decoded audio, never simulated. Notion controls expose source resync and
pending source saves independently from cached availability.
