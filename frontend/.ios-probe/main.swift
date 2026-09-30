import UIKit
import WebKit

class VC: UIViewController {
  var web: WKWebView!
  override func viewDidLoad() {
    super.viewDidLoad()
    let cfg = WKWebViewConfiguration()
    // Optional: open a specific conversation (BWK_CONV) so a probe can act on
    // its contents — e.g. tapping an image to check the viewer.
    let conv = ProcessInfo.processInfo.environment["BWK_CONV"] ?? ""
    let seed = conv.isEmpty ? "" :
      "try { localStorage.setItem('butter_active_conv', '\(conv)'); } catch (e) {}"
    // Report display-mode:standalone + navigator.standalone like a home-screen app
    let js = """
    (function(){
      Object.defineProperty(navigator,'standalone',{value:true,configurable:true});
      \(seed)
      // A WKWebView doesn't match @media (display-mode: standalone), but a
      // home-screen PWA does — copy those rules out of the media block so the
      // test environment matches the real installed app.
      document.addEventListener('DOMContentLoaded', () => {
        const out = [];
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules } catch (e) { continue }
          for (const r of rules) {
            if (r.media && String(r.media).includes('display-mode') && String(r.media).includes('standalone')) {
              for (const inner of r.cssRules) out.push(inner.cssText);
            }
          }
        }
        if (out.length) {
          const st = document.createElement('style');
          st.textContent = out.join('\\n');
          document.head.appendChild(st);
        }
      });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => q.includes('display-mode: standalone')
        ? {matches:true, media:q, onchange:null, addListener(){}, removeListener(){},
           addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false}}
        : mm(q);
    })();
    """
    cfg.userContentController.addUserScript(
      WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web = WKWebView(frame: .zero, configuration: cfg)
    web.scrollView.contentInsetAdjustmentBehavior = .never
    view.addSubview(web)
    web.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      web.topAnchor.constraint(equalTo: view.topAnchor),
      web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    let url = ProcessInfo.processInfo.environment["BWK_URL"]
      ?? "https://your-site.example.com/?t=your-secret-token"
    web.load(URLRequest(url: URL(string: url)!))
    // After load: perform the mode's action, then dump the geometry.
    // BWK_MODE reaches the app as SIMCTL_CHILD_BWK_MODE when launched by simctl.
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
      let mode = ProcessInfo.processInfo.environment["BWK_MODE"] ?? "drawer"
      let action: String
      switch mode {
      case "lightbox": action = "document.querySelector('.msg-image')?.click()"
      case "keyboard": action = "document.querySelector('textarea')?.focus()"
      default:         action = "document.querySelector('.menu-btn')?.click()"
      }
      self.web.evaluateJavaScript(action + "; 'ok'") { _, _ in }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        let probe = """
        (function(){
          const R=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();
            return {top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height)}};
          const cs=getComputedStyle(document.documentElement);
          const sb=document.querySelector('.sidebar');
          return JSON.stringify({
            saTop:cs.getPropertyValue('--sa-top').trim(), saBottom:cs.getPropertyValue('--sa-bottom').trim(),
            appVh:cs.getPropertyValue('--app-vh').trim(),
            innerH:window.innerHeight, screenH:window.screen.height,
            lvh:(()=>{const d=document.createElement('div');d.style.cssText='position:absolute;height:100lvh';
              document.body.appendChild(d);const v=d.getBoundingClientRect().height;d.remove();return Math.round(v)})(),
            sidebar:R('.sidebar'), footer:R('.sidebar-footer'), btn:R('.new-chat-btn'),
            overlay:R('.imgview'), bigImg:R('.imgview-img'),
            screenH:Math.round(window.screen.height),
            sbScrollH:sb?sb.scrollHeight:null, sbClientH:sb?sb.clientHeight:null
          });
        })()
        """
        self.web.evaluateJavaScript(probe) { r, e in
          print("PROBE_RESULT: \(r ?? "nil") err=\(String(describing: e))")
        }
      }
    }
  }
  override var prefersStatusBarHidden: Bool { false }
}

class AD: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ a: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = VC()
    window?.makeKeyAndVisible()
    return true
  }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AD.self))
