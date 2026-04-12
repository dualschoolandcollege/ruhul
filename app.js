// app.js
//
// This script ties together Firebase Authentication and the
// Realtime Database to control multiple GPIO outputs on an ESP32
// board. It is a unified version of the separate index.js and
// auth.js files used in the original Random Nerd Tutorials example.
// The pins array defines which GPIO numbers are exposed via the
// web interface. Each pin has its own ON/OFF buttons and a state
// indicator. When a logged in user clicks a button, the corresponding
// database value is updated (0 = OFF, 1 = ON). The ESP32 listens
// for changes on these database paths and drives the physical pins
// accordingly.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {
  getDatabase,
  ref,
  onValue,
  set,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js';

// TODO: Replace the following configuration with your own Firebase project
// configuration. These values can be obtained from your Firebase
// console under Project Settings > General.
// Your web app's Firebase configuration. These values are specific to your
// Firebase project. Do NOT share your API key or credentials publicly in a
// production system; this example includes them because the user provided
// them explicitly for demonstration. If you rotate your API key, update
// these values accordingly.
const firebaseConfig = {
  apiKey: "AIzaSyCSPP-EY_kMPlwoZQPmHymHAHEwj99d_5I",
  authDomain: "mohaiminul-automation.firebaseapp.com",
  databaseURL: "https://mohaiminul-automation-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "mohaiminul-automation",
  storageBucket: "mohaiminul-automation.firebasestorage.app",
  messagingSenderId: "1040602580747",
  appId: "1:1040602580747:web:7d7e6599b2ee2c5a9c040e"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

// Allowed Firebase user UID. Only this user can view and control the GPIO
// interface. Replace with your own UID to restrict access.
const allowedUid = 'mvi23GYUfDcNCyVonuVEZSCxFPz2';

// Define the GPIO pins to control. The order here must match the order
// of the cards defined in index.html. If you add or remove pins,
// update both this array and the HTML accordingly. Re-ordering the
// array will change which pin is controlled by which card.
const pins = [15, 2, 4, 16, 17, 5, 18, 19, 21, 22, 23, 13, 12, 14, 27, 26, 25, 33, 32];

// Wait for the DOM to load before querying elements and attaching
// event listeners.
document.addEventListener('DOMContentLoaded', () => {
  // Reference UI elements
  const loginForm = document.querySelector('#login-form');
  const loginElement = loginForm;
  const contentElement = document.querySelector('#content-sign-in');
  const userDetailsElement = document.querySelector('#user-details');
  const authBarElement = document.querySelector('#authentication-bar');
  const errorMessage = document.getElementById('error-message');

  // Prepare arrays to store DOM references and database references
  const stateElements = [];
  const btnElements = [];
  // References to the command paths (outputs/digital).  These are
  // used when writing a new state to Firebase.
  const commandRefs = [];
  // References to the status paths (status/digital).  The UI
  // subscribes to these to display the actual state reported by the
  // device.  Using a dedicated status path prevents the UI from
  // showing a state change until the ESP32 acknowledges it
  // 【35850693949175†L1208-L1221】.
  const statusRefs = [];
  // Keep track of whether a given GPIO has a pending state change.
  // When a user clicks a button, the entry for that pin is set to true and the
  // button is temporarily disabled.  It will be re‑enabled when the
  // status update arrives from Firebase.
  const pending = [];

  // Desired states for each GPIO.  While currentStates reflects the
  // state reported by the device, desiredStates records what the user
  // intends each output to be.  When a user clicks rapidly, the
  // desired state may change multiple times before the ESP32 reports
  // an update.  We use this array to avoid sending intermediate
  // commands that will be immediately superseded, improving
  // responsiveness when toggling quickly.
  const desiredStates = [];

  // Debounce timers for each GPIO.  When a user clicks a button we
  // schedule a command to write the desired state after a short
  // delay.  If another click occurs before the timer fires, the
  // previous timer is cancelled and a new one is scheduled.  This
  // coalesces multiple rapid toggles into a single database write.
  const debounceTimers = [];

  // Interval (in milliseconds) used for debouncing GPIO commands.
  // Commands triggered by button clicks will be delayed by this
  // amount.  If another click occurs during the delay, the timer
  // resets.  A modest value (200ms) prevents spamming the database
  // when the user clicks repeatedly while still feeling responsive.
  const DEBOUNCE_DELAY = 200;

  // Track the last known state of each GPIO as reported by the device.  We
  // update these values whenever a status update arrives from Firebase.
  // When toggling a pin we always derive the new desired value from this
  // array instead of reading from the UI text, which can become out of
  // sync during network delays or failed operations.  Keeping an internal
  // representation of the real state prevents the UI from sending the
  // wrong command when it already displays an outdated state.
  const currentStates = [];

  // Array of unsubscribe functions for the status listeners.  Each element
  // corresponds to a subscription created via onValue() so that we can
  // detach the listener when the user logs out or when the UI is reset.
  // Without detaching these listeners, subsequent logins can accumulate
  // multiple listeners on the same database path, causing duplicate
  // callbacks and sluggish UI updates.  See Firebase's guidance on
  // improving listener efficiency by removing unnecessary listeners【396260281090169†L1640-L1656】.
  let statusUnsubscribers = [];

  // --------------------------------------------------------------
  // Heartbeat support
  //
  // To prevent the Firebase Realtime Database connection from going
  // idle, we send a small heartbeat value from the web app to the
  // database on a regular interval.  The ESP32 subscribes to this
  // path (see firebase-web-app-gpio-control-code-improved.ino) to
  // keep the underlying TCP/WebSocket connection active even when no
  // GPIO commands are exchanged.  Conversely, the web app listens
  // for updates on the device's heartbeat status path so that it can
  // also receive periodic updates and keep its connection alive.
  // These functions manage starting and stopping the heartbeat
  // transmissions and subscriptions based on authentication state.

  // Holds the interval ID for the outgoing heartbeat timer.  When
  // non-null, a periodic heartbeat is active.
  let heartbeatTimer = null;
  // Holds the unsubscribe function for the device heartbeat listener.
  let deviceHeartbeatUnsub = null;

  /**
   * Write a timestamp to the /board1/webHeartbeat/<uid> path.  We use
   * Date.now() as the timestamp.  Errors are logged to the console but
   * otherwise ignored because the next interval will retry.  This
   * function is called both on a timer and immediately when the
   * heartbeat starts to ensure at least one write occurs after
   * authentication.
   *
   * @param {string} uid The Firebase UID of the authenticated user.
   */
  function sendHeartbeat(uid) {
    const hbRef = ref(database, `board1/webHeartbeat/${uid}`);
    set(hbRef, Date.now()).catch((err) => {
      console.error('Error sending web heartbeat:', err);
    });
  }

  /**
   * Start sending periodic heartbeat messages.  If an existing
   * heartbeat timer is running, it will be cleared before starting a
   * new one.  A heartbeat is sent immediately upon starting, then
   * every three minutes.  The interval is kept intentionally shorter
   * than the device's heartbeat interval (5 minutes) to ensure
   * overlapping activity from both sides.  See
   * firebase-web-app-gpio-control-code-improved.ino for the device
   * counterpart.
   *
   * @param {string} uid The Firebase UID of the authenticated user.
   */
  function startHeartbeat(uid) {
    // Stop any existing heartbeat to avoid duplicates
    stopHeartbeat();
    // Immediately send a heartbeat so the connection stays alive
    sendHeartbeat(uid);
    // Schedule periodic heartbeats every 3 minutes (180000 ms)
    heartbeatTimer = setInterval(() => {
      sendHeartbeat(uid);
    }, 180000);
  }

  /**
   * Stop sending heartbeat messages by clearing the interval.  This is
   * called when the user logs out or becomes unauthorized.  Clearing
   * the timer prevents the web app from writing to the database
   * unexpectedly when no one is logged in.
   */
  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /**
   * Subscribe to the device's heartbeat status path.  The ESP32 writes
   * its own heartbeat to /board1/status/heartbeat every few minutes.
   * By listening on this path the web app receives a steady stream of
   * updates even when no GPIO changes occur.  This keeps the web
   * connection alive.  The callback is intentionally left minimal
   * since the data is not used directly; however, you could update
   * UI elements or logs here if desired.
   */
  function attachDeviceHeartbeat() {
    // Detach any existing listener before attaching a new one
    detachDeviceHeartbeat();
    const hbStatusRef = ref(database, 'board1/status/heartbeat');
    deviceHeartbeatUnsub = onValue(hbStatusRef, (snap) => {
      // The snapshot value is just a timestamp.  We could display it
      // somewhere in the UI if desired, but the primary purpose is to
      // ensure Firebase keeps the socket open.  Uncomment to log:
      // console.log('Device heartbeat received:', snap.val());
    });
  }

  /**
   * Detach the device heartbeat listener.  Called when the user logs
   * out or becomes unauthorized to prevent memory leaks and to stop
   * receiving updates.
   */
  function detachDeviceHeartbeat() {
    if (deviceHeartbeatUnsub) {
      try {
        deviceHeartbeatUnsub();
      } catch (err) {
        console.warn('Error detaching device heartbeat listener', err);
      }
      deviceHeartbeatUnsub = null;
    }
  }

  // Populate arrays based on the number of pins
  pins.forEach((pin, idx) => {
    const index = idx + 1;
    stateElements[idx] = document.getElementById(`state${index}`);
    btnElements[idx] = document.getElementById(`btn${index}`);
    // Command reference for writes
    commandRefs[idx] = ref(database, `board1/outputs/digital/${pin}`);
    // Status reference for reads
    statusRefs[idx] = ref(database, `board1/status/digital/${pin}`);
    // Initialize pending state to false
    pending[idx] = false;
    // Initialise last known state to 0 (OFF).  We assume pins start off.
    currentStates[idx] = 0;
  });

  // Function to toggle UI elements depending on authentication state
  const setupUI = (user) => {
    // Reset any error message
    if (errorMessage) errorMessage.textContent = '';
    if (user && user.uid === allowedUid) {
      // Authenticated and authorized user: show the UI
      loginElement.style.display = 'none';
      contentElement.style.display = 'block';
      authBarElement.style.display = 'block';
      userDetailsElement.style.display = 'block';
      userDetailsElement.innerHTML = user.email;
      // Ensure any existing listeners are detached before attaching new ones.
      // This prevents multiple subscriptions from stacking up when the user
      // logs out and back in, which would slow down the UI.  Each
      // onValue() returns a function that removes the listener when
      // called.  We store these in statusUnsubscribers and call them
      // whenever we reset the UI.
      const detachStatusListeners = () => {
        if (statusUnsubscribers && statusUnsubscribers.length) {
          statusUnsubscribers.forEach((unsub) => {
            try {
              if (typeof unsub === 'function') unsub();
            } catch (err) {
              console.warn('Error detaching listener', err);
            }
          });
        }
        statusUnsubscribers = [];
      };
      // Detach any pre‑existing listeners before attaching new ones.
      detachStatusListeners();

      // Subscribe to status changes for each pin.  We listen on the
      // status paths instead of the command paths so that the UI
      // reflects the actual state reported by the ESP32.  If the
      // network fails and the command does not reach the device, the
      // status value will not change and the UI will remain in the
      // previous state.  Store each unsubscribe function so we can
      // detach them later.
      statusRefs.forEach((statusRef, idx) => {
        const unsubscribe = onValue(statusRef, (snap) => {
          const val = snap.val();
          // Normalize the value to either 1 or 0 (treat null/undefined as 0)
          const normalized = val === 1 ? 1 : 0;
          // Update our internal last known state
          currentStates[idx] = normalized;
          // Initialise desired state on first update if not set yet
          if (typeof desiredStates[idx] === 'undefined') {
            desiredStates[idx] = normalized;
          }
          const btn = btnElements[idx];
          const stateEl = stateElements[idx];
          // Determine if the device's reported state matches the user's desired state
          const matchesDesired = desiredStates[idx] === normalized;
          if (btn && stateEl) {
            if (matchesDesired) {
              // Clear any debounce timer because we have reached the desired state
              if (debounceTimers[idx]) {
                clearTimeout(debounceTimers[idx]);
                debounceTimers[idx] = null;
              }
              // No longer pending
              pending[idx] = false;
              // Update button appearance to reflect the actual state
              btn.classList.remove('pending');
              if (normalized === 1) {
                btn.classList.remove('off');
                btn.classList.add('on');
                btn.textContent = 'ON';
              } else {
                btn.classList.remove('on');
                btn.classList.add('off');
                btn.textContent = 'OFF';
              }
              // Show the actual state in the label
              stateEl.textContent = normalized === 1 ? 'ON' : 'OFF';
            } else {
              // The device state does not yet match the desired state.  Keep the
              // button in a pending style and reflect the desired value.
              pending[idx] = true;
              btn.classList.remove('on');
              btn.classList.remove('off');
              btn.classList.add('pending');
              btn.textContent = desiredStates[idx] === 1 ? 'ON' : 'OFF';
              // Show an ellipsis to indicate that the command is in flight
              stateEl.textContent = '…';
            }
            // Always allow further toggles
            btn.disabled = false;
          }
        });
        statusUnsubscribers[idx] = unsubscribe;
      });

      // Initial desired state and debounce timer setup.  After
      // subscribing to status updates but before attaching the
      // click handlers, initialise the desiredStates and debounceTimers
      // arrays for this session.  Without resetting these on every
      // login the UI could retain stale desired values from previous
      // sessions which would cause incorrect toggling behaviour.
      pins.forEach((pin, idx) => {
        desiredStates[idx] = currentStates[idx];
        debounceTimers[idx] = null;
      });

      // Start the web heartbeat mechanism now that the user is logged in.
      // Send periodic heartbeats to /board1/webHeartbeat/<uid> and listen
      // for device heartbeat updates to keep the Firebase connection
      // active even when no GPIO commands are sent.  We use the
      // authenticated user's UID so each client writes to its own path.
      startHeartbeat(user.uid);
      attachDeviceHeartbeat();

      // Attach toggle event listener to each button. Use once to avoid duplicate listeners
      btnElements.forEach((btn, idx) => {
        if (btn && !btn.hasAttribute('data-listener-added')) {
          btn.setAttribute('data-listener-added', 'true');
          btn.addEventListener('click', () => {
            // Determine the desired state based on the last desired state, not the actual state.
            const currentDesired = typeof desiredStates[idx] === 'number' ? desiredStates[idx] : 0;
            const newDesired = currentDesired === 1 ? 0 : 1;
            // Record the user's desired state
            desiredStates[idx] = newDesired;
            // Mark this pin as pending until the device reports the same state
            pending[idx] = true;
            // Immediately reflect the desired state in the UI.  Show an ellipsis on the
            // status label and update the button to indicate the requested state.  We
            // do not disable the button so the user can toggle again while the
            // command is in flight.
            const stateEl = stateElements[idx];
            if (stateEl) {
              stateEl.textContent = '…';
            }
            btn.classList.remove('on');
            btn.classList.remove('off');
            btn.classList.add('pending');
            btn.textContent = newDesired === 1 ? 'ON' : 'OFF';
            // Cancel any previously scheduled command for this pin
            if (debounceTimers[idx]) {
              clearTimeout(debounceTimers[idx]);
            }
            // Schedule a new command after the debounce delay.  If the user toggles
            // again before this timer fires, it will be cancelled and rescheduled.
            debounceTimers[idx] = setTimeout(() => {
              const finalVal = desiredStates[idx];
              // Send the command to Firebase.  We intentionally do not disable the
              // button here; the status listener will resolve the pending state
              // when the device acknowledges the change.
              set(commandRefs[idx], finalVal);
            }, DEBOUNCE_DELAY);
          });
        }
      });

      // Attach reset event handler once when authorized.  The reset button
      // sets all GPIOs to OFF by writing 0 to each command path.  It also
      // marks each button as pending and disables interaction until the
      // status updates arrive.  We use a data attribute to avoid adding
      // multiple listeners on repeated auth state changes.
      const resetButton = document.getElementById('reset-button');
      if (resetButton && !resetButton.hasAttribute('data-listener-added')) {
        resetButton.setAttribute('data-listener-added', 'true');
        resetButton.addEventListener('click', (e) => {
          e.preventDefault();
          // Disable the reset button itself to prevent rapid consecutive resets
          resetButton.disabled = true;
          // Iterate through each pin and request an OFF state
          pins.forEach((pin, idx) => {
            // Update the desired state to OFF
            desiredStates[idx] = 0;
            pending[idx] = true;
            // Cancel any pending debounce timer so the reset command is sent immediately
            if (debounceTimers[idx]) {
              clearTimeout(debounceTimers[idx]);
              debounceTimers[idx] = null;
            }
            const btn = btnElements[idx];
            const stateEl = stateElements[idx];
            if (stateEl) {
              stateEl.textContent = '…';
            }
            if (btn) {
              // Reflect the reset request in the UI by showing pending OFF
              btn.classList.remove('on');
              btn.classList.remove('off');
              btn.classList.add('pending');
              btn.textContent = 'OFF';
              // Keep buttons enabled so the user can still interact while waiting
              btn.disabled = false;
            }
            // Immediately write the OFF command to Firebase
            set(commandRefs[idx], 0);
          });
          // Re-enable the reset button after a short delay.  The status
          // listeners will resolve the pending states and update the UI.
          setTimeout(() => {
            resetButton.disabled = false;
          }, 2000);
        });
      }
    } else {
      // Not authenticated or unauthorized: show login and hide everything else
      loginElement.style.display = 'block';
      authBarElement.style.display = 'none';
      userDetailsElement.style.display = 'none';
      contentElement.style.display = 'none';
      // If the user is logged in but unauthorized, sign out to prevent DB access
      if (user && user.uid !== allowedUid) {
        signOut(auth).catch((error) => {
          console.error('Sign out error:', error.message);
        });
        if (errorMessage) errorMessage.textContent = 'You do not have permission to access this app.';
      }
      // Detach any status listeners when logging out or when unauthorized.
      if (statusUnsubscribers && statusUnsubscribers.length) {
        statusUnsubscribers.forEach((unsub) => {
          try {
            if (typeof unsub === 'function') unsub();
          } catch (err) {
            console.warn('Error detaching listener', err);
          }
        });
        statusUnsubscribers = [];
      }

      // Stop sending and receiving heartbeat messages when not logged in or unauthorized.
      stopHeartbeat();
      detachDeviceHeartbeat();
    }
  };

  // Listen for changes in authentication state.  When the user logs in or out,
  // Firebase will trigger this callback with the current user (or null).  We
  // configure the UI only in response to these events to ensure the login
  // requirement is enforced.  We deliberately avoid calling setupUI() on
  // page load; instead the login form is visible by default (see index.html).
  onAuthStateChanged(auth, (user) => {
    setupUI(user);
  });

  // Handle login form submission
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('input-email').value;
    const password = document.getElementById('input-password').value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      loginForm.reset();
      if (errorMessage) errorMessage.textContent = '';
    } catch (error) {
      if (errorMessage) errorMessage.textContent = error.message;
      console.error('Login error:', error.message);
    }
  });

  // Handle logout link click
  const logoutLink = document.querySelector('#logout-link');
  logoutLink.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout error:', error.message);
    }
  });

  // WiFi configuration UI logic.  The cloud interface can push new
  // credentials to the database which the ESP32 listens to via the
  // config stream.  This code toggles the visibility of the config
  // form and writes the entered values to the appropriate paths in
  // Firebase.
  const wifiConfigButton = document.getElementById('wifi-config-button');
  const wifiConfigDiv = document.getElementById('wifi-config');
  const wifiSaveButton = document.getElementById('wifi-save-button');
  const wifiCancelButton = document.getElementById('wifi-cancel-button');
  if (wifiConfigButton && wifiConfigDiv && wifiSaveButton && wifiCancelButton) {
    wifiConfigButton.addEventListener('click', () => {
      // Show the form and hide the config button
      wifiConfigDiv.style.display = 'block';
      wifiConfigButton.style.display = 'none';
    });
    wifiCancelButton.addEventListener('click', () => {
      // Hide the form and show the config button
      wifiConfigDiv.style.display = 'none';
      wifiConfigButton.style.display = 'inline-block';
    });
    wifiSaveButton.addEventListener('click', async () => {
      const ssid1 = document.getElementById('wifi-ssid1').value.trim();
      const pass1 = document.getElementById('wifi-pass1').value;
      const ssid2 = document.getElementById('wifi-ssid2').value.trim();
      const pass2 = document.getElementById('wifi-pass2').value;
      try {
        // Write each non‑empty field to its corresponding path.  Using separate
        // set() calls avoids overwriting other children under /board1/config.
        if (ssid1) {
          await set(ref(database, 'board1/config/primary_ssid'), ssid1);
        }
        if (pass1) {
          await set(ref(database, 'board1/config/primary_pass'), pass1);
        }
        if (ssid2) {
          await set(ref(database, 'board1/config/secondary_ssid'), ssid2);
        }
        if (pass2) {
          await set(ref(database, 'board1/config/secondary_pass'), pass2);
        }
        // Optionally clear the fields after save
        document.getElementById('wifi-ssid1').value = '';
        document.getElementById('wifi-pass1').value = '';
        document.getElementById('wifi-ssid2').value = '';
        document.getElementById('wifi-pass2').value = '';
        // Hide the form and show the config button
        wifiConfigDiv.style.display = 'none';
        wifiConfigButton.style.display = 'inline-block';
        alert('WiFi credentials saved to Firebase. The device will update shortly.');
      } catch (err) {
        console.error('Error saving WiFi credentials:', err);
        alert('Error saving WiFi credentials: ' + err.message);
      }
    });
  }

  // Hardware reboot button logic.  Sends a value of 1 to
  // /board1/control/reboot which the ESP32 listens for to trigger a
  // board restart.  The device clears the flag after reading it so
  // successive reboots require another click.
  const rebootButton = document.getElementById('reboot-button');
  if (rebootButton) {
    rebootButton.addEventListener('click', async () => {
      try {
        await set(ref(database, 'board1/control/reboot'), 1);
        alert('Reboot command sent. The ESP32 should restart shortly.');
      } catch (err) {
        console.error('Error sending reboot command:', err);
        alert('Error sending reboot command: ' + err.message);
      }
    });
  }
});