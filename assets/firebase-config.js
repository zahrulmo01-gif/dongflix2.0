import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  getDatabase, 
  ref, 
  get, 
  set, 
  remove, 
  runTransaction, 
  increment 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyC0fPxoN63hX6QsXnCet-xXhLhOLkUnWS4",
  authDomain: "donghu-91808.firebaseapp.com",
  databaseURL: "https://donghu-91808-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "donghu-91808",
  storageBucket: "donghu-91808.firebasestorage.app",
  messagingSenderId: "181024131291",
  appId: "1:181024131291:web:4c3cca5e5e0eda475a24fe",
  measurementId: "G-QFQ77XRGQ8"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { 
  app, 
  auth, 
  db, 
  ref, 
  get, 
  set, 
  remove, 
  runTransaction, 
  increment, 
  onAuthStateChanged 
};
