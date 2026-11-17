# Air 2S Flight Simulator

A browser flight simulator for the DJI Air 2S that you fly with the real
RC-N1 controller plugged into your computer by USB. No install, no drivers:
the page reads the sticks directly.

Unofficial project, not affiliated with DJI.

## Run it

```
npm start
```

Then open <http://localhost:8080> in **Chrome or Edge on a computer**.
(Node 18+ is the only requirement; there are no dependencies to install.)

## Connect the RC-N1

1. Switch the controller on. The drone can stay off.
2. Plug a USB-C **data** cable into the port on the **bottom** of the
   controller (the charging port), not the phone connector on top.
3. In the menu press **Connect RC-N1** and choose the DJI serial port. If two
   are listed, pick "For Protocol".
4. Move the sticks — the live values appear under *RC-N1 setup and
   troubleshooting*. If a stick works backwards, tick its box there.

The simulator talks to the controller with the same serial commands the
community RC-N1 gamepad bridges use (simulator mode on, then poll the stick
channels at 50 Hz). Only the two sticks and the gimbal wheel are sent by the
controller this way; the mode switch, RTH and Fn buttons are on the keyboard.

Without the controller you can fly with a keyboard, any gamepad, or
on-screen sticks on a touch screen.

## Controls (Mode 2)

| Action | RC-N1 / gamepad | Keyboard |
| --- | --- | --- |
| Up / down, turn | Left stick | W S / A D |
| Forward / back, sideways | Right stick | Arrow keys |
| Camera tilt | Gimbal wheel / triggers | Z X |
| Start motors | Both sticks down and inward for 1 s | |
| Take off / land | A | T |
| Return to home | B | H |
| Cine / Normal / Sport | X | 1 2 3 |
| Camera view (gimbal, chase, pilot) | Y | V |
| Reset, mute, menu | | R, M, Esc |

## What is simulated

- Speeds from the Air 2S spec sheet: 5 / 15 / 19 m/s in Cine / Normal / Sport,
  6 m/s climb and descent, 120 m altitude limit, about 31 minutes of battery.
- GPS-style hover: the drone brakes and holds position when you let go, and
  leans into the wind.
- Auto take-off, landing, return-to-home, low-battery RTH and forced landing.
- Gimbal tilt from -90° to +24°, with a 22 mm-equivalent field of view.
- Crashes: trees, buildings, hard landings and water.
- A countryside to explore: a lake with a road bridge you can fly under, a
  village with a church, a farm, a construction site with a tower crane, a
  high-voltage power line, a guyed radio mast, a wind farm with turning
  blades, drifting hot-air balloons, and a training yard with slalom poles
  and arches next to the take-off field. Everything you can see is solid,
  including the wires.
- Missions: free flight, an 8-gate timed course, and precision landing.

## Graphics

Rendering runs through a post-processing pipeline — HDR bloom, ACES tone
mapping, a gentle colour grade with a soft vignette, and anti-aliasing — on
top of sky-lit reflections (an environment probe) for the drone and metal
surfaces, soft sun shadows, atmospheric haze, drifting clouds and rippling
water. The spinning propellers blur into discs.

A **Graphics** setting in the menu (Low / Medium / High / Ultra) trades detail
for speed and can be changed at any time, including mid-flight. It controls
render resolution, shadows, bloom and cloud density but never touches flight
behaviour. The default is picked from your display; drop to Low if the view
stutters. The choice is remembered.

## Development

```
npm test
```

`src/duml.js` (controller protocol), `src/drone.js` (flight model) and
`src/terrain.js` (world shape and obstacles) have no browser dependencies and are covered
by the tests. three.js and its post-processing add-ons are vendored in
`vendor/` and `vendor/jsm/` (MIT licence) and resolved through the import map
in `index.html`, so there is still nothing to install.
