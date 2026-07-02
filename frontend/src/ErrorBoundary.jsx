import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }
  componentDidCatch(error, info) {
    this.setState({ error, info })
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:'40px',color:'#f66',background:'#111',fontFamily:'monospace',height:'100vh',overflow:'auto'}}>
          <h2 style={{marginBottom:'16px'}}>Runtime Error</h2>
          <pre style={{background:'#1a1a1a',padding:'16px',borderRadius:'8px',overflow:'auto',fontSize:'13px',color:'#ff8888'}}>
            {this.state.error.toString()}
          </pre>
          <h3 style={{margin:'24px 0 8px',color:'#aaa'}}>Component Stack</h3>
          <pre style={{background:'#1a1a1a',padding:'16px',borderRadius:'8px',overflow:'auto',fontSize:'11px',color:'#888'}}>
            {this.state.info?.componentStack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
