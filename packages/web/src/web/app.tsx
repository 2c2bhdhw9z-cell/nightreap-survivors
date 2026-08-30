import { Route, Switch } from "wouter";
import Index from "./pages/index";
import AdminPage from "./pages/admin";
import { Provider } from "./components/provider";

function App() {
  return (
    <Provider>
      <Switch>
        <Route path="/" component={Index} />
        <Route path="/admin" component={AdminPage} />
      </Switch>
    </Provider>
  );
}

export default App;
