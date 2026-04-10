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
          // Update the text label
          if (stateElements[idx]) {
            stateElements[idx].textContent = normalized === 1 ? 'ON' : 'OFF';
          }
          // Update button class and label based on new value
          const btn = btnElements[idx];
          if (btn) {
            // Remove pending class since the status is now updated
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
            // Re‑enable the button now that the status is updated
            btn.disabled = false;
            pending[idx] = false;
          }
        });
        statusUnsubscribers[idx] = unsubscribe;
      });

      // Attach toggle event listener to each button. Use once to avoid duplicate listeners
      btnElements.forEach((btn, idx) => {
        if (btn && !btn.hasAttribute('data-listener-added')) {
          btn.setAttribute('data-listener-added', 'true');
          btn.addEventListener('click', () => {
            // Prevent multiple toggles while a previous change is pending
            if (pending[idx]) {
              return;
            }
            // Determine current state from our internal state array rather than the UI.
            // The UI can become stale if a previous toggle failed or a network delay
            // prevented a status update.  Using currentStates ensures we toggle
            // relative to the actual state reported by the device.
            const currentVal = typeof currentStates[idx] === 'number' ? currentStates[idx] : 0;
            const newVal = currentVal === 1 ? 0 : 1;
            // Set pending flag and disable the button until the status update arrives
            pending[idx] = true;
            btn.disabled = true;
            // Show a pending indicator so the user knows the command is being sent.
            // We don't assume the new state until the ESP32 acknowledges it, but
            // showing "…" indicates the request is in progress.  Once the
            // status listener fires, the UI will update accordingly.
            if (stateElements[idx]) {
              stateElements[idx].textContent = '…';
            }
            // Optionally update the button label to reflect the requested action
            // so the user sees what will happen when the command succeeds.
            btn.textContent = newVal === 1 ? 'ON' : 'OFF';
            // Apply pending style to the button and remove on/off classes.  This
            // visually indicates that a command is in flight.
            btn.classList.remove('on');
            btn.classList.remove('off');
            btn.classList.add('pending');
            // Send the command to the database.  The ESP32 will receive this update
            // via its stream and update the status accordingly.
            set(commandRefs[idx], newVal);
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
          // Disable the reset button to prevent repeated clicks
          resetButton.disabled = true;
          // For each pin, send a command to turn it OFF (0)
          pins.forEach((pin, idx) => {
            // Mark this pin as pending and disable its button if not already
            pending[idx] = true;
            const btn = btnElements[idx];
            if (btn) {
              btn.disabled = true;
              // Show pending indicator and update label to OFF
              if (stateElements[idx]) {
                stateElements[idx].textContent = '…';
              }
              btn.textContent = 'OFF';
              btn.classList.remove('on');
              btn.classList.remove('off');
              btn.classList.add('pending');
            }
            // Send the OFF command to Firebase
            set(commandRefs[idx], 0);
          });
          // Re-enable the reset button after a short delay.  The status
          // listeners will update the UI when the ESP32 acknowledges the
          // changes, but we allow the user to click again if necessary.
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