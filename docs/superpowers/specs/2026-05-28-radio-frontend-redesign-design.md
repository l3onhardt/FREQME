# Radio Frontend Redesign Design

## Goal

Fully redesign the radio frontend into a high-end, warm, deeply immersive listening experience. The new product should feel like a late-night companion radio: calm, premium, breathable, rhythmic, and emotionally present without being noisy or heavy.

This is a full frontend reset for all existing user-facing pages, not a partial refresh.

## Product Direction

The new experience should sit between two aesthetics:

- `B` — deep-night emotional wraparound
- `C` — boutique lifestyle-brand polish

The result should lean toward `B` while borrowing the refinement and restraint of `C`.

### Core adjectives

- warm
- premium
- soft
- breathable
- rhythmic
- quiet
- companion-like
- elegant
- intimate

### Experience principles

- The interface should feel like entering a warm night radio room.
- Visuals should be rich, but never crowded.
- Motion should feel alive, but never busy.
- The user should feel guided, not managed.
- Every state should be legible, especially loading, playing, and request feedback.

## Scope

This redesign covers the full three-screen flow already present in the app:

1. Login
2. Onboarding
3. Player

Each screen should be rebuilt under one unified visual language.

## Non-goals

- No product flow expansion beyond the existing three-screen structure.
- No backend behavior changes in this slice.
- No new account system, library view, or settings section in this redesign.
- No experimental layout that sacrifices readability for drama.

## Information Architecture

The current three-screen flow remains, but each page is re-authored:

- `Login` becomes an atmospheric entry space.
- `Onboarding` becomes a soft “tuning” sequence.
- `Player` becomes the main immersive stage.

The redesign should preserve the user’s mental model: sign in, tune the station, then listen.

## Visual System

### Color palette

Use a warm dark foundation rather than cold black.

Recommended palette direction:

- Base background: deep brown-black, wine-black, charcoal-plum
- Secondary surfaces: muted amber, smoky rose, dark caramel
- Accent color: warm gold, soft orange, amber glow
- Text: warm off-white and soft gray, never stark white by default

### Surface treatment

- Soft gradients instead of flat fills
- Gentle glow edges on active panels
- Subtle blur or glass-like layering for foreground surfaces
- Low-intensity shadows rather than hard contrast shadows

### Typography

- Large titles should feel calm and open, not aggressive.
- Body text should be easy to scan in low light.
- Hierarchy must remain obvious across all screens.
- Avoid dense blocks of text and avoid overly tight line spacing.

### Shape language

- Rounded corners with a premium but not playful feel
- Cards and inputs should appear soft and tactile
- Buttons should feel polished and easy to reach

## Screen Design

### 1. Login Screen

#### Role

The login screen is not just a QR page. It is the first emotional entry into the radio.

#### Layout

- A centered main card containing the QR code
- A short welcome headline above or near the card
- A supporting subtitle describing the station experience
- A login completion CTA that appears only after successful scan/ready state

#### Visual intent

- The background should feel like a warm night sky or a softly lit room.
- The QR card should be luminous but not flashy.
- The page should feel premium and calm immediately on arrival.

#### Interaction notes

- Keep the page simple.
- Show explicit scanning and ready states.
- When login succeeds, clearly reveal the next step without abrupt visual change.

### 2. Onboarding Screen

#### Role

Onboarding is a tuning ritual, not a form. It should feel like the user is establishing a relationship with the station.

#### Structure

Use a three-step progression that already matches the app’s current logic:

1. Choose the host voice
2. Enter display name and music notes
3. Choose the current listening mode

#### Visual intent

- Each step should feel like a “channel tuning” panel.
- Choice cards should look like refined station presets.
- Text inputs should feel conversational and low-friction.
- There should be enough spacing for the screen to breathe.

#### Interaction notes

- Selected states must be obvious but restrained.
- Use gentle glow, border emphasis, or slight lift for active choices.
- The primary action should remain simple and predictable.
- The step transition should feel smooth and sequential, not abrupt.

### 3. Player Screen

#### Role

The player screen is the main stage and the most atmospheric part of the product.

#### Layout hierarchy

Top to bottom, the preferred information order is:

1. Channel or scene label
2. Current track information
3. DJ voice/message area
4. Song request input
5. Playback controls

#### Visual intent

- A full-screen atmospheric background or blurred image layer.
- A gentle overlay that preserves readability.
- The track info should feel like the hero content.
- The DJ message should sit in a calm, centered listening zone.

#### Song request area

- The request field should feel like speaking to the host, not filing a command.
- The submit action should feel gentle and immediate.
- Success and in-progress states must be explicit and warm.

#### Playback controls

- The play/pause control should be the visual anchor.
- Skip and volume should be secondary and less dominant.
- Controls must remain accessible and easy to understand.

#### State handling

The player needs polished treatment for:

- playing
- paused
- switching tracks
- generating TTS
- processing a request
- error and retry states

Each state should have distinct but consistent feedback.

## Motion System

Motion should create breath and rhythm, not spectacle.

### Allowed motion patterns

- Subtle fade/raise entrance on panels
- Soft highlight and glow on active selections
- Very low-amplitude background drift or gradient movement
- Gentle transitions for loading and request feedback

### Avoid

- Bouncy or playful motion
- Distracting particle storms
- High-frequency flashing
- Motion that harms readability

## Component State Model

Every reusable UI element should have a complete state set.

### Buttons

- default
- hover
- active/pressed
- disabled
- loading

### Inputs

- default
- focused
- filled
- error
- disabled

### Choice cards

- default
- hover
- selected
- disabled

### Player states

- idle
- playing
- paused
- loading
- switching
- request-processing
- error

This makes the UI coherent and prevents the experience from feeling improvised.

## Implementation Plan at a Glance

The redesign should primarily touch these files:

- `frontend/index.html`
- `frontend/css/radio.css`
- `frontend/js/radio.js`

### HTML responsibilities

- Rebuild the page structure for the three screens
- Introduce cleaner wrappers and semantic sectioning where needed
- Keep the current app flow intact

### CSS responsibilities

- Replace the current visual system
- Define the warm premium palette, typography, surfaces, and interactions
- Add responsive behavior for smaller screens
- Ensure the UI remains legible in low-light conditions

### JS responsibilities

- Preserve the current workflow and state transitions
- Update the step and screen transitions to match the new UI
- Drive loading, request, and playback state messaging
- Ensure selected states and UI feedback remain synchronized with app logic

## Responsive Behavior

The design must work on smaller screens without losing the premium feel.

Rules:

- Preserve spacing and visual hierarchy.
- Reduce grid complexity on narrow widths.
- Avoid cramped cards or input rows.
- Maintain touch-friendly hit areas.

## Accessibility and Readability

Even though the design is atmospheric, it must remain usable.

- Maintain strong contrast for body text and controls.
- Keep focus states visible.
- Ensure buttons and inputs are large enough for touch.
- Avoid relying on color alone to convey selected or disabled states.

## Success Criteria

The redesign is successful if:

- The app feels like a warm, premium late-night radio product.
- The three-screen flow still feels simple and natural.
- The player screen feels emotionally immersive without losing clarity.
- All main actions and states remain easy to understand.
- The design looks unified instead of patchwork.

## First Implementation Slice

The initial implementation should focus on the visual and interaction reset of the existing frontend only:

- rebuild the three screens with the new layout and structure
- replace the old cold/dark styling with the warm premium palette
- add the new motion and state treatments
- keep the current backend and radio logic intact for now

Later slices can refine the design further, add richer transitions, or expand the product surface if needed.
